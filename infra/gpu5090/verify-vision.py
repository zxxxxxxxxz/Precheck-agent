"""Bounded local-only synthetic capacity canary. No originals or vendor bodies logged.
This script does not enable a capability or change runtime configuration.
"""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import statistics
import subprocess
import threading
import time
import urllib.error
import urllib.request
from PIL import Image, ImageDraw

MODEL = 'Qwen/Qwen3.5-9B'
REVISION = 'c202236235762e1c871ad0ccb60c8ee5ba337b9a'

def run(args):
    if args.base_url not in ('http://127.0.0.1:6006', 'http://127.0.0.1:8000'):
        raise ValueError('canary_loopback_only')
    token = Path(args.token_file).read_text().strip()
    report = {'model': MODEL, 'revision': REVISION, 'mode': 'text' if args.text_only else 'vision', 'passed': False, 'checks': [], 'gpu': []}
    output = Path(args.report_dir)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    stop = threading.Event()
    def sample():
        while not stop.is_set():
            try:
                values = subprocess.check_output(['nvidia-smi', '--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], timeout=5, text=True).strip().split(',')
                report['gpu'].append({'used_mib': int(values[0]), 'total_mib': int(values[1])})
            except Exception:
                report['gpu_sample_failed'] = True
            stop.wait(0.5)
    thread = threading.Thread(target=sample, daemon=True)
    thread.start()
    def request(name, messages, expected=None):
        payload = {'model': MODEL, 'messages': messages, 'temperature': 0, 'max_tokens': 128,
                   'chat_template_kwargs': {'enable_thinking': False}}
        structured = any(isinstance(message.get('content'), list) for message in messages)
        allowed = ['EMPTY', 'SIGNED', 'PRINTED', 'HANDWRITING', 'STAMP', 'READY', 'UNCERTAIN']
        if structured:
            payload['response_format'] = {'type': 'json_schema', 'json_schema': {'name': 'synthetic_vision_canary', 'strict': True, 'schema': {'type': 'object', 'additionalProperties': False, 'required': ['answer'], 'properties': {'answer': {'type': 'string', 'enum': allowed}}}}}
        started = time.monotonic()
        entry = {'name': name, 'passed': False}
        report['checks'].append(entry)
        req = urllib.request.Request(args.base_url + '/v1/chat/completions',
            data=json.dumps(payload).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=180) as response:
                envelope = json.loads(response.read(1_048_576))
            choice = envelope['choices'][0]
            entry.update(elapsed_ms=round((time.monotonic()-started)*1000), usage=envelope['usage'])
            content = choice['message']['content'].strip()
            if structured:
                value = json.loads(content)
                if not isinstance(value, dict) or set(value) != {'answer'} or value['answer'] not in allowed:
                    raise ValueError('invalid_canary_schema')
                answer = value['answer']; entry['observed_code'] = answer
            else:
                answer = content.upper().rstrip('.!')
            entry['passed'] = envelope['model'] == MODEL and choice['finish_reason'] == 'stop' and (expected is None or answer == expected)
        except urllib.error.HTTPError as error:
            entry['error_code'] = 'http_' + str(error.code)
        except Exception as error:
            entry['error_code'] = type(error).__name__
        if not entry['passed']:
            raise ValueError('canary_check_failed')
    try:
        for i in range(3):
            request('text_before_' + str(i), [{'role': 'user', 'content': 'Synthetic test. Reply exactly READY.'}], 'READY')
        if not args.text_only:
            # Input reaches the adapter's 16 MP boundary; the model processor
            # must stay within its independently configured 1 MP budget.
            for kind, expected, size in [('empty', 'EMPTY', (768, 512)), ('printed', 'PRINTED', (768, 512)), ('stamp', 'STAMP', (768, 512)), ('page_budget', 'READY', (4000, 4000))]:
                image = Image.new('RGB', size, 'white')
                draw = ImageDraw.Draw(image)
                if kind == 'empty':
                    draw.text((70, 180), 'Signature:', fill='black'); draw.line((180, 200, 550, 200), fill='black', width=2)
                    prompt = 'The signature line is EMPTY or SIGNED? Reply one word.'
                elif kind == 'printed':
                    draw.text((70, 180), 'Signature: ALICE EXAMPLE (printed name)', fill='black')
                    prompt = 'Is the image PRINTED text or HANDWRITING? Reply one word.'
                elif kind == 'stamp':
                    draw.ellipse((170, 110, 400, 340), outline='red', width=7); draw.text((220, 220), 'TEST STAMP', fill='red')
                    prompt = 'Does the image show a synthetic red STAMP or an empty signature line? Reply one word.'
                else:
                    for y in range(50, 3950, 70): draw.text((50, y), 'SYNTHETIC PUBLIC CAPACITY TEST', fill='black')
                    prompt = 'Synthetic capacity test. Reply exactly READY.'
                content = io.BytesIO(); image.save(content, format='PNG')
                uri = 'data:image/png;base64,' + base64.b64encode(content.getvalue()).decode()
                request(kind, [{'role': 'user', 'content': [{'type': 'text', 'text': prompt}, {'type': 'image_url', 'image_url': {'url': uri}}]}], expected)
            for i in range(3):
                request('text_after_' + str(i), [{'role': 'user', 'content': 'Synthetic test. Reply exactly READY.'}], 'READY')
        text_checks = [c['elapsed_ms'] for c in report['checks'] if c['name'].startswith('text_') and c['passed']]
        report['text_median_ms'] = statistics.median(text_checks)
        if args.baseline:
            baseline = json.loads(Path(args.baseline).read_text())
            report['text_latency_ratio'] = report['text_median_ms'] / max(1, baseline['text_median_ms'])
            if report['text_latency_ratio'] > 2.5: raise ValueError('text_latency_regression')
        if not report['gpu'] or report.get('gpu_sample_failed'): raise ValueError('gpu_sampling_unavailable')
        report['peak_gpu_mib'] = max(s['used_mib'] for s in report['gpu'])
        report['minimum_free_gpu_mib'] = min(s['total_mib']-s['used_mib'] for s in report['gpu'])
        if report['minimum_free_gpu_mib'] < 1024: raise ValueError('gpu_headroom_insufficient')
        report['passed'] = True
    except Exception as error:
        report['failure_code'] = str(error) if isinstance(error, ValueError) else type(error).__name__
    finally:
        stop.set(); thread.join(6)
        if report['gpu']:
            report['peak_gpu_mib'] = max(s['used_mib'] for s in report['gpu'])
            report['minimum_free_gpu_mib'] = min(s['total_mib']-s['used_mib'] for s in report['gpu'])
        target = output / 'capacity.json'; target.write_text(json.dumps(report, indent=2)); target.chmod(0o600)
    print(json.dumps({key: report[key] for key in ('mode', 'passed', 'failure_code', 'peak_gpu_mib', 'minimum_free_gpu_mib', 'text_latency_ratio') if key in report}))
    return 0 if report['passed'] else 1

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='http://127.0.0.1:6006')
    parser.add_argument('--token-file', default='/data/hsbc/secrets/qwen-api.token')
    parser.add_argument('--report-dir', required=True)
    parser.add_argument('--text-only', action='store_true')
    parser.add_argument('--baseline')
    raise SystemExit(run(parser.parse_args()))
