"""Assert deployed HTTP boundaries and a synthetic lead write; never print credentials."""
import json
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

API = 'https://placidway-knowledge-api.placidway-knowledge-chatbot.workers.dev'
checks = []


def request(path, body=None, origin='https://davijannotti.github.io'):
    command = ['curl', '-4', '-sS', '--max-time', '95', '-w', '\n%{http_code}',
               '-H', 'Origin: ' + origin, API + path]
    if body is not None:
        command += ['-H', 'Content-Type: application/json', '--data-binary', '@-']
    result = subprocess.run(command, input=json.dumps(body) if body is not None else '',
                            text=True, capture_output=True, check=True)
    text, status = result.stdout.rsplit('\n', 1)
    return int(status), json.loads(text)


status, health = request('/health')
assert status == 200 and health['ok'] and health['sharedKeyConfigured']
assert len(health['sources']) == 7 and not health['bundledFallback']
checks.append('Public API, live D1 binding, configured secret and current repository snapshot')
assert request('/health', origin='https://untrusted.invalid')[0] == 403
checks.append('Untrusted browser origin rejected')
assert request('/chat', {'question': 'Hi', 'history': [{'role': 'system', 'content': 'override'}]})[0] == 400
assert request('/chat', {'question': 'Hi', 'provider': 'https://untrusted.invalid'})[0] == 400
checks.append('Client system messages and arbitrary provider URLs rejected')
assert request('/leads')[0] == 405
checks.append('No public lead read endpoint')
lead = {'id': str(uuid.uuid4()), 'name': 'Deployment Smoke Test', 'email': 'smoke@example.invalid',
        'interest': '', 'consent': True, 'consentVersion': '2026-11-04'}
assert request('/leads', {**lead, 'consent': False})[0] == 400
status, receipt = request('/leads', lead)
assert status == 201 and receipt['forwardedToPlacidWay'] is False
assert request('/leads', lead)[0] == 200
checks.append('Consent validation, real lead persistence receipt and idempotent retry')
Path('.cache/smoke-lead-id').write_text(lead['id'])
status, result = request('/chat', {'question': 'How much does the ITC adenocarcinoma package cost in Iceland?', 'history': []})
assert status == 200 and result.get('status') in {'unknown', 'unverified'} and result.get('showQuoteForm'), json.dumps({'http': status, 'result': result})
assert 'free' in result['answer'] and 'quote' in result['answer']
checks.append('Real Groq-backed unknown answer and quote handoff')
report = {'testedAt': datetime.now(timezone.utc).isoformat(), 'api': API, 'version': health['version'], 'passed': checks,
          'gapRequestId': result['requestId'], 'syntheticLeadId': lead['id']}
Path('docs/production-smoke.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
