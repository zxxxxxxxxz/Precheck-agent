"""Bounded synthetic capability probes; retain only outcomes, timings and usage."""
import argparse
import datetime
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:6006')
parser.add_argument('--token-file', default='/data/hsbc/secrets/qwen-api.token')
parser.add_argument('--report', required=True)
parser.add_argument('--skip-long', action='store_true')
args = parser.parse_args()
token = Path(args.token_file).read_text().strip()
model = 'Qwen/Qwen3.8-27B'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
report = {'model': model, 'synthetic_only': True, 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks': []}

def request(path, payload):
    return urllib.request.Request(args.base_url + path, data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})

def chat(text, **extra):
    return {'model': model, 'messages': [{'role': 'user', 'content': text}],
            'temperature': 0, 'max_tokens': 256,
            'chat_template_kwargs': {'enable_thinking': False}, **extra}

def check(name, payload, validate, path='/v1/chat/completions'):
    begin = time.monotonic()
    item = {'name': name, 'passed': False}
    try:
        with opener.open(request(path, payload), timeout=180) as response:
            data = json.load(response)
        assert data['model'] == model
        assert validate(data)
        item.update(passed=True, usage=data.get('usage'), finish_reason=data['choices'][0]['finish_reason'])
    except urllib.error.HTTPError as exc:
        item.update(error_type='HTTPError', status=exc.code)
    except Exception as exc:
        item['error_type'] = type(exc).__name__
    item['elapsed_seconds'] = round(time.monotonic() - begin, 3)
    report['checks'].append(item)
    print(json.dumps(item), flush=True)

check('chinese_non_thinking', chat('只回复这两个汉字：完成'),
      lambda d: '完成' in d['choices'][0]['message']['content'] and not d['choices'][0]['message'].get('reasoning_content'))
schema = {'type': 'object', 'properties': {'ok': {'type': 'boolean'}, 'amount': {'type': 'integer'}},
          'required': ['ok', 'amount'], 'additionalProperties': False}
check('strict_json_schema', chat('Return a JSON object with ok=true and amount=100.',
      response_format={'type': 'json_schema', 'json_schema': {'name': 'deployment_probe', 'strict': True, 'schema': schema}}),
      lambda d: json.loads(d['choices'][0]['message']['content']) == {'ok': True, 'amount': 100})
tool = {'type': 'function', 'function': {'name': 'get_demo_status', 'description': 'Get the status of a synthetic deployment marker.',
    'parameters': {'type': 'object', 'properties': {'marker': {'type': 'string'}}, 'required': ['marker'], 'additionalProperties': False}}}
def valid_tool(data):
    calls = data['choices'][0]['message'].get('tool_calls', [])
    return len(calls) == 1 and calls[0]['function']['name'] == 'get_demo_status' and json.loads(calls[0]['function']['arguments']) == {'marker': 'DEPLOY_OK'}
check('automatic_tool_call', chat('Use get_demo_status to look up the marker DEPLOY_OK.', tools=[tool], tool_choice='auto'), valid_tool)
check('thinking_control', chat('Calculate 17 multiplied by 23. End with the numerical answer.', max_tokens=1024,
      chat_template_kwargs={'enable_thinking': True, 'preserve_thinking': False}, reasoning_effort='low'),
      lambda d: '391' in (d['choices'][0]['message'].get('content') or '') and bool(d['choices'][0]['message'].get('reasoning_content') or d['choices'][0]['message'].get('reasoning')))

begin = time.monotonic()
item = {'name': 'streaming_with_usage', 'passed': False}
try:
    first = None
    usage = None
    done = False
    text = ''
    with opener.open(request('/v1/chat/completions', chat('Write a short paragraph explaining what a synthetic software test is.', max_tokens=128,
            stream=True, stream_options={'include_usage': True})), timeout=180) as response:
        for raw in response:
            if not raw.startswith(b'data: '):
                continue
            event = raw[6:].strip()
            if event == b'[DONE]':
                done = True
                break
            data = json.loads(event)
            if data.get('usage'):
                usage = data['usage']
            for choice in data.get('choices', []):
                content = choice.get('delta', {}).get('content')
                if content:
                    first = first if first is not None else time.monotonic()
                    text += content
    elapsed = time.monotonic() - begin
    assert done and text and usage and first is not None
    item.update(passed=True, usage=usage, first_token_seconds=round(first-begin, 3),
                end_to_end_output_tokens_per_second=round(usage['completion_tokens']/elapsed, 2))
except urllib.error.HTTPError as exc:
    item.update(error_type='HTTPError', status=exc.code)
except Exception as exc:
    item['error_type'] = type(exc).__name__
item['elapsed_seconds'] = round(time.monotonic()-begin, 3)
report['checks'].append(item)
print(json.dumps(item), flush=True)

if not args.skip_long:
    from transformers import AutoTokenizer
    lock = json.loads(Path('/data/hsbc/deploy/model.lock.json').read_text())
    tokenizer = AutoTokenizer.from_pretrained(lock['local_path'], local_files_only=True)
    tokens = tokenizer.encode('This is synthetic padding for a bounded context-capacity test. ', add_special_tokens=False)
    prompt = (tokens * (31000 // len(tokens) + 1))[:31000]
    check('31000_token_input', {'model': model, 'prompt': prompt, 'max_tokens': 32, 'temperature': 0},
          lambda d: d['usage']['prompt_tokens'] == 31000 and 0 < d['usage']['completion_tokens'] <= 32, '/v1/completions')
    check('ready_after_long_request', chat('Reply exactly DEPLOY_OK.', max_tokens=32),
          lambda d: 'DEPLOY_OK' in d['choices'][0]['message']['content'])
try:
    report['gpu_memory_mib'] = subprocess.check_output(['nvidia-smi', '--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], text=True).strip()
except (OSError, subprocess.SubprocessError):
    report['gpu_memory_mib'] = None
report['all_passed'] = all(x['passed'] for x in report['checks'])
report['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
Path(args.report).write_text(json.dumps(report, indent=2) + '\n')
raise SystemExit(0 if report['all_passed'] else 1)
