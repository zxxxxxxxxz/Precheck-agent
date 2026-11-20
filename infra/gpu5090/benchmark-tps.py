#!/usr/bin/env python3
"""Bounded synthetic streaming benchmark; never saves secrets or generated text."""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def request(base, token, prompt, output_tokens):
    payload = {
        'model': 'Qwen/Qwen3.5-9B', 'prompt': prompt,
        'temperature': 0, 'max_tokens': output_tokens, 'ignore_eos': True,
        'stream': True, 'stream_options': {'include_usage': True},
        'return_token_ids': True,
    }
    req = urllib.request.Request(base + '/v1/completions',
        data=json.dumps(payload).encode(), headers={
            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    # Do not inherit download acceleration or system proxy settings.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    started = time.perf_counter()
    first = last = None
    first_tokens = 0
    streamed_tokens = 0
    chunks = 0
    finish = None
    usage = None
    done = False
    try:
        with opener.open(req, timeout=180) as response:
            for raw in response:
                if not raw.startswith(b'data: '):
                    continue
                event = raw[6:].strip()
                if event == b'[DONE]':
                    done = True
                    break
                data = json.loads(event)
                now = time.perf_counter()
                if data.get('error'):
                    raise ValueError('API stream error')
                if data.get('usage'):
                    usage = data['usage']
                for choice in data.get('choices', []):
                    ids = choice.get('token_ids')
                    if ids:
                        if first is None:
                            first = now
                            first_tokens = len(ids)
                        last = now
                        chunks += 1
                        streamed_tokens += len(ids)
                    elif choice.get('text'):
                        raise ValueError('Missing exact stream token IDs')
                    if choice.get('finish_reason'):
                        finish = choice['finish_reason']
        ended = time.perf_counter()
        valid = (done and usage and usage.get('completion_tokens') == output_tokens
                 and usage.get('prompt_tokens') == len(prompt)
                 and streamed_tokens == output_tokens and finish == 'length'
                 and first is not None and last > first)
        if not valid:
            raise ValueError('Incomplete or inconsistent token accounting')
        return {
            'ok': True, 'input_tokens': len(prompt), 'output_tokens': output_tokens,
            'streamed_token_ids': streamed_tokens, 'stream_chunks': chunks,
            'first_chunk_tokens': first_tokens, 'finish_reason': finish,
            'ttft_seconds': first - started,
            'generation_seconds': last - first, 'request_seconds': ended - started,
            'decode_tps': (output_tokens - first_tokens) / (last - first),
            'end_to_end_output_tps': output_tokens / (last - started),
            'prompt_cache_details': usage.get('prompt_tokens_details'),
        }
    except Exception as error:
        # Exception strings can contain response bodies. Store only type/status.
        return {'ok': False, 'error_type': type(error).__name__,
                'http_status': getattr(error, 'code', None),
                'request_seconds': time.perf_counter() - started,
                'streamed_token_ids': streamed_tokens}


def monitor_gpu(stop, readings):
    while not stop.is_set():
        try:
            result = subprocess.run(['nvidia-smi',
                '--query-gpu=memory.used,utilization.gpu,temperature.gpu,power.draw',
                '--format=csv,noheader,nounits'], capture_output=True, text=True,
                check=True, timeout=5)
            values = [float(v.strip()) for v in result.stdout.splitlines()[0].split(',')]
            readings.append(dict(zip(['memory_mib', 'utilization_percent',
                                      'temperature_c', 'power_w'], values)))
        except (OSError, ValueError, subprocess.SubprocessError):
            return
        stop.wait(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:6006')
    parser.add_argument('--token-file', default='/data/hsbc/secrets/qwen-api.token')
    parser.add_argument('--fixtures', required=True)
    parser.add_argument('--prepare-model')
    parser.add_argument('--profile', choices=['smoke', 'local', 'short', 'app'], default='local')
    parser.add_argument('--output')
    parser.add_argument('--gpu-monitor', action='store_true')
    args = parser.parse_args()
    fixture_path = Path(args.fixtures)
    if args.prepare_model:
        from transformers import AutoTokenizer
        tokenizer = AutoTokenizer.from_pretrained(args.prepare_model, local_files_only=True)
        fixtures = {'_run_salt': uuid.uuid4().hex}
        for length in [128, 1024, 4096]:
            fixtures[str(length)] = []
            for i in range(40):
                nonce = hashlib.sha256(f'{fixtures["_run_salt"]}-{length}-{i}'.encode()).hexdigest()
                text = nonce + '\nContinue writing a detailed synthetic numbered list. '
                text += 'This is public synthetic benchmark padding with no business data. ' * 700
                ids = tokenizer.encode(text, add_special_tokens=False)[:length]
                assert len(ids) == length
                fixtures[str(length)].append(ids)
        fixture_path.write_text(json.dumps(fixtures))
        print(json.dumps({'fixtures_prepared': True, 'sha256': hashlib.sha256(fixture_path.read_bytes()).hexdigest()}))
        return
    if not args.output:
        parser.error('--output is required when running a benchmark')
    fixtures = json.loads(fixture_path.read_text())
    token = Path(args.token_file).read_text().strip()
    profiles = {
        'smoke': [(128, 32, 1, 1)],
        'short': [(128, 1024, 1, 3)],
        'local': [(128, 1024, 1, 3), (1024, 1024, 1, 3),
                  (4096, 1024, 1, 3), (128, 512, 2, 8), (128, 512, 4, 8)],
        'app': [(128, 1024, 1, 3), (1024, 1024, 1, 3)],
    }
    report = {
        'started_at': utc(), 'profile': args.profile, 'base_url': args.base_url,
        'model': 'Qwen/Qwen3.5-9B', 'endpoint': '/v1/completions',
        'fixture_sha256': hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
        'script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'settings': {'temperature': 0, 'ignore_eos': True, 'return_token_ids': True},
        'metrics': {'decode_tps': '(output_tokens-first_chunk_tokens)/(last_token_at-first_token_at)',
                    'end_to_end_output_tps': 'output_tokens/(last_token_at-request_start)',
                    'aggregate_output_tps': 'all_successful_output_tokens/batch_wall_seconds'},
        'cases': [],
    }
    stop = threading.Event()
    readings = []
    monitor = threading.Thread(target=monitor_gpu, args=(stop, readings), daemon=True)
    if args.gpu_monitor:
        monitor.start()
    try:
        report['warmup'] = request(args.base_url, token, fixtures['128'][39], 128)
        if not report['warmup']['ok']:
            raise RuntimeError('Warmup failed')
        print(json.dumps({'warmup': 'passed'}), flush=True)
        for length, out, concurrency, count in profiles[args.profile]:
            # Use disjoint prefixes across cases, including the same-sized prompts.
            offset = 0 if concurrency == 1 else (3 if concurrency == 2 else 11)
            if args.profile == 'app':
                offset = 20
            elif args.profile == 'smoke':
                offset = 38
            started = time.perf_counter()
            with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
                futures = [pool.submit(request, args.base_url, token,
                    fixtures[str(length)][offset+i], out) for i in range(count)]
                rows = [future.result() for future in futures]
            elapsed = time.perf_counter() - started
            good = [row for row in rows if row['ok']]
            case = {'input_tokens': length, 'output_tokens': out,
                'client_concurrency': concurrency, 'requests': count,
                'successful_requests': len(good), 'batch_seconds': elapsed,
                'aggregate_output_tps': sum(row['output_tokens'] for row in good)/elapsed,
                'samples': rows}
            if good:
                for field in ['decode_tps', 'end_to_end_output_tps', 'ttft_seconds']:
                    case[field + '_median'] = statistics.median(row[field] for row in good)
                    case[field + '_max'] = max(row[field] for row in good)
            report['cases'].append(case)
            Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
            print(json.dumps({k: v for k, v in case.items() if k != 'samples'}), flush=True)
            if len(good) != count:
                raise RuntimeError('Benchmark request failed')
    finally:
        stop.set()
        if args.gpu_monitor:
            monitor.join(timeout=6)
        if readings:
            report['gpu_sample_count'] = len(readings)
            report['gpu_observed_max'] = {key: max(row[key] for row in readings) for key in readings[0]}
        report['ended_at'] = utc()
        report['passed'] = (report.get('warmup', {}).get('ok', False)
            and len(report['cases']) == len(profiles[args.profile])
            and all(case['requests'] == case['successful_requests'] for case in report['cases']))
        Path(args.output).write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
