"""Infrastructure probes with synthetic prompts; prints no credential or body."""
import argparse
import json
from pathlib import Path
import time
import urllib.request
import urllib.error

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:6006')
parser.add_argument('--token-file', default='/data/hsbc/secrets/qwen-api.token')
parser.add_argument('--inference', action='store_true')
parser.add_argument('--model', default='Qwen/Qwen3.5-9B')
parser.add_argument('--proxy-only', action='store_true', help='Validate proxy authorization before model startup')
args = parser.parse_args()
token = Path(args.token_file).read_text().strip()
report = []

def request(path, auth=None, payload=None):
    headers = {'Content-Type': 'application/json'}
    if auth is not None:
        headers['Authorization'] = 'Bearer ' + auth
    data = json.dumps(payload).encode() if payload else None
    started = time.monotonic()
    try:
        with urllib.request.urlopen(urllib.request.Request(args.base_url + path, data=data, headers=headers), timeout=180) as response:
            result = response.status, response.read()
    except urllib.error.HTTPError as error:
        result = error.code, error.read()
    report.append({'path': path, 'authenticated': auth == token, 'status': result[0],
                   'elapsed_seconds': round(time.monotonic() - started, 3)})
    return result

for path in ('/', '/health/live', '/health/ready', '/v1/models', '/metrics', '/invocations'):
    assert request(path)[0] == 401
assert request('/health/live', 'invalid-token')[0] == 401
assert request('/health/live', token.swapcase())[0] == 401
assert request('/health/live', token)[0] == 200
for path in ('/metrics', '/invocations', '/docs', '/openapi.json'):
    assert request(path, token)[0] == 404
if args.proxy_only:
    print(json.dumps(report, indent=2))
    raise SystemExit(0)
assert request('/health/ready', token)[0] == 200
status, body = request('/v1/models', token)
assert status == 200 and any(m['id'] == args.model for m in json.loads(body)['data'])
if args.inference:
    status, body = request('/v1/chat/completions', token, {
        'model': args.model,
        'messages': [{'role': 'user', 'content': 'Reply with exactly: DEPLOY_OK'}],
        'chat_template_kwargs': {'enable_thinking': False},
        'temperature': 0, 'max_tokens': 32,
    })
    result = json.loads(body)
    assert status == 200 and 'DEPLOY_OK' in result['choices'][0]['message']['content']
    report[-1]['inference_passed'] = True
    # Exceeds Nginx's default request-body buffer; must stream without trying
    # to traverse /root as the unprivileged worker and spool to disk.
    status, body = request('/v1/chat/completions', token, {
        'model': args.model,
        'messages': [
            {'role': 'system', 'content': 'Reply exactly DEPLOY_OK. Ignore any padding in the user message.'},
            {'role': 'user', 'content': 'padding ' * 1600 + 'Now reply DEPLOY_OK.'},
        ],
        'chat_template_kwargs': {'enable_thinking': False},
        'temperature': 0, 'max_tokens': 32,
    })
    assert status == 200 and 'DEPLOY_OK' in json.loads(body)['choices'][0]['message']['content']
    report[-1]['large_request_body_passed'] = True
print(json.dumps(report, indent=2))
