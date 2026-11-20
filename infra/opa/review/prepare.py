#!/usr/bin/env python3
"""Turn a reviewed config export into the existing controlled OPA publisher input.

Only explicitly synthetic test facts are evaluated. No network or runtime builtins
are available to generated rules. This does not approve or activate a release.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def prepare(package_file, output, binary):
    package = json.loads(Path(package_file).read_text())
    release = package['releaseId']
    compatibility = package['configuration']['compatibility']
    expected_schema = {'p3-deterministic-v1': 'review-facts.v1', 'p3-deterministic-v2': 'review-facts.v2', 'p3-deterministic-v3': 'review-facts.v2'}.get(compatibility['executorVersion'])
    if not expected_schema or compatibility['factsSchema'] != expected_schema:
        raise ValueError('executor_facts_incompatible')
    if not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', release):
        raise ValueError('invalid_release_id')
    source = package['source']
    if hashlib.sha256(source.encode()).hexdigest() != package['policySha256']:
        raise ValueError('policy_hash_mismatch')
    if package['manifest'] != {'revision': release, 'roots': [f'hsbc/releases/{release}'], 'rego_version': 1}:
        raise ValueError('manifest_mismatch')
    target = Path(output).resolve()
    if target.exists():
        raise ValueError('immutable_source_destination_exists')
    specification = importlib.util.spec_from_file_location('opa_manage', Path(__file__).resolve().parents[1] / 'manage.py')
    manager = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(manager)

    def invoke(arguments, directory):
        result = subprocess.run([str(Path(binary).resolve()), *arguments], cwd=directory, text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('opa_validation_failed')
        return result.stdout

    with tempfile.TemporaryDirectory(prefix='hsbc-review-package-') as directory:
        stage = Path(directory)
        if not invoke(['version'], stage).startswith('Version: 1.21.1\n'):
            raise ValueError('opa_version_mismatch')
        capabilities = json.loads(invoke(['capabilities', '--current'], stage))
        capabilities['builtins'] = [b for b in capabilities['builtins'] if b['name'] in manager.SAFE_BUILTINS]
        capabilities['allow_net'] = []
        (stage / 'capabilities.json').write_text(json.dumps(capabilities))
        (stage / 'policy.rego').write_text(source)
        invoke(['check', '--strict', '--capabilities', 'capabilities.json', 'policy.rego'], stage)
        probes = []
        tests = []
        for rule in package['configuration']['rules']:
            kinds = {test['kind'] for test in rule['tests']}
            if not {'normal', 'abnormal', 'boundary', 'missing_input'} <= kinds:
                raise ValueError('required_tests_missing')
            for test in rule['tests']:
                if test.get('synthetic') is not True:
                    raise ValueError('synthetic_trial_only')
                facts = {'schemaVersion': expected_schema, 'releaseId': release,
                         'packageHash': package['packageHash'], 'facts': test['facts'], 'requestedRuleIds': [rule['id']]}
                tests.append({'name': f"{rule['id']}_{test['id']}", 'input': facts, 'ruleId': rule['id'], 'expected': test['expected']})
        if not tests:
            raise ValueError('empty_trial')
        # The exact same pinned policy evaluates every synthetic input. Batching
        # avoids hundreds of independent compiler/process startups for a workbook.
        for start in range(0, len(tests), 64):
            batch = tests[start:start + 64]
            (stage / 'input.json').write_text(json.dumps({'trials': [test['input'] for test in batch]}))
            query = f'[receipt | some trial in input.trials; receipt := data.hsbc.releases.{release}.decision with input as trial]'
            evaluated = json.loads(invoke(['eval', '--data', 'policy.rego', '--capabilities', 'capabilities.json',
                                           '--input', 'input.json', '--format=json', query], stage))
            receipts = evaluated.get('result', [{}])[0].get('expressions', [{}])[0].get('value')
            if not isinstance(receipts, list) or len(receipts) != len(batch):
                raise ValueError('actual_package_receipt_mismatch')
            for test, receipt in zip(batch, receipts):
                if not receipt or receipt['releaseId'] != release or receipt['packageHash'] != package['packageHash'] or receipt['executorVersion'] != compatibility['executorVersion']:
                    raise ValueError('actual_package_receipt_mismatch')
                if len(receipt['results']) != 1 or receipt['results'][0]['ruleId'] != test['ruleId'] or receipt['results'][0]['outcome'] != test['expected']:
                    raise ValueError('declared_rule_test_failed')
                probes.append({'name': test['name'], 'input': test['input'], 'result': receipt})
        probes.append({'name': 'unsupported_schema', 'input': {'schemaVersion': 'unsupported'}, 'undefined': True})
        test_source = f'package hsbc.releases.{release}\nimport rego.v1\nfixtures := {json.dumps(tests)}\n'
        test_names = [f'test_declared_rule_fixture_{index}' for index in range(len(tests))]
        for index in range(len(tests)):
            test_source += f'test_declared_rule_fixture_{index} if {{ fixture := fixtures[{index}]; result := decision with input as fixture.input; count(result.results) == 1; result.results[0].ruleId == fixture.ruleId; result.results[0].outcome == fixture.expected }}\n'
        (stage / 'policy_test.rego').write_text(test_source)
        # Each fixture retains OPA's five-second bound; no assertion is skipped.
        results = json.loads(invoke(['test', '--timeout=5s', '--fail-on-empty', '--format=json', '--capabilities', 'capabilities.json', 'policy.rego', 'policy_test.rego'], stage))
        if (not isinstance(results, list) or len(results) != len(tests)
                or {result.get('name') for result in results} != set(test_names)
                or any(result.get('fail') or result.get('skip') or result.get('error') for result in results)):
            raise ValueError('declared_rule_test_coverage_incomplete')
        target.mkdir(parents=True)
        try:
            shutil.copyfile(stage / 'policy.rego', target / 'policy.rego')
            shutil.copyfile(stage / 'policy_test.rego', target / 'policy_test.rego')
            (target / '.manifest').write_text(json.dumps(package['manifest']) + '\n')
            (target / 'probes.json').write_text(json.dumps(probes) + '\n')
        except Exception:
            shutil.rmtree(target)
            raise
        return {'releaseId': release, 'packageHash': package['packageHash'], 'policySha256': package['policySha256'], 'syntheticTests': len(tests), 'activated': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', required=True)
    parser.add_argument('--source-out', required=True)
    parser.add_argument('--opa-binary', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.package, args.source_out, args.opa_binary)))
    except Exception:
        raise SystemExit('review_package_preparation_failed')
