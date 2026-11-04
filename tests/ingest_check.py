import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.ingest import extract

source = {'id': '2', 'url': 'https://www.placidway.com/package/7903/example'}
html = '''<h1>Adenocarcinoma package</h1><section id="about"><h2>Cost</h2>
<p>These are starting estimates.</p><table><tr><th>Program</th><th>Duration</th><th>Cost USD</th></tr>
<tr><td>Out-Patient</td><td>3 weeks</td><td>$18,995</td></tr>
<tr><td>In-Patient</td><td>3 weeks</td><td>$30,000</td></tr></table>
<h2>Exclusions</h2><p>Additional procedures and travel are not included in this example package. Ask for a personalized quote before booking travel.</p>
<div class="related-packages-sec"><p>Unrelated dental package $50</p></div></section>'''
page = extract(html, source)
text = '\n'.join(c['text'] for c in page['chunks'])
assert 'Program | Duration | Cost USD\nOut-Patient | 3 weeks | $18,995' in text
assert 'In-Patient | 3 weeks | $30,000' in text
assert '$50' not in text
assert all(c['url'] == source['url'] for c in page['chunks'])
assert any(c['heading'] == 'Exclusions' for c in page['chunks'])
try:
    extract('<h1>Broken page</h1>', source)
except ValueError:
    pass
else:
    raise AssertionError('Missing source selector must fail closed')
print('Ingestion table context, exclusions, recommendation removal and missing-selector handling: passed')
