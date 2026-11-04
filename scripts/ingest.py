"""Fetch exactly the assessment allowlist and publish an all-or-nothing snapshot."""
import argparse
import hashlib
import json
import re
import time
import urllib.request
import urllib.robotparser
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup, NavigableString

ROOT = Path(__file__).resolve().parents[1]
UA = 'PlacidWayAssessmentBot/1.0 (+https://github.com/davijannotti/placidway-knowledge-chatbot)'
ORIGIN = 'https://www.placidway.com'
SELECTORS = {
    '1': '#about, #details, #treatments, #qualifications, #destination, #location',
    '2': '#about', '3': '#about', '4': '#about',
    '5': '.center-videos-page > #about, .center-videos-page > .related-videos',
    '6': '#prices, main #about',
    '7': 'main.search-pricing_page .pack-inner-content',
}


def compact(text):
    return re.sub(r'\s+', ' ', text).strip()


def blocks(node):
    if isinstance(node, NavigableString):
        return
    if node.name in {'script', 'style', 'form', 'button', 'noscript', 'iframe', 'nav'}:
        return
    if node.name in {'h1', 'h2', 'h3', 'h4'}:
        yield ('heading', compact(node.get_text(' ', strip=True)))
    elif node.name == 'table':
        rows = [[compact(c.get_text(' ', strip=True)) for c in row.find_all(['th', 'td'])]
                for row in node.find_all('tr')]
        if rows:
            header = ' | '.join(rows[0])
            for row in rows[1:]:
                if len(row) == len(rows[0]) and row[0]:
                    yield ('text', header + '\n' + ' | '.join(row))
    elif node.name == 'dl':
        yield ('text', compact(node.get_text(' ', strip=True)))
    elif node.name in {'p', 'li', 'address'} and not node.find(['h2', 'h3', 'p', 'li', 'table', 'div']):
        text = compact(node.get_text(' ', strip=True))
        if text:
            yield ('text', text)
    else:
        for child in node.children:
            yield from blocks(child)


def extract(raw, source):
    soup = BeautifulSoup(raw, 'html.parser')
    title = compact(soup.h1.get_text(' ', strip=True)) if soup.h1 else ''
    nodes = soup.select(SELECTORS[source['id']])
    if not title or not nodes:
        raise ValueError(f"Page {source['id']}: expected content selector missing")
    chunks = []
    heading, lines = title, []
    banner = soup.select_one('.reviews-voice-row .actual-price') if source['id'] in {'2', '3', '4'} else None

    def flush():
        if lines:
            text = '\n'.join(lines)
            chunks.append({'id': source['id'] + '-' + hashlib.sha256((heading + text).encode()).hexdigest()[:12],
                           'sourceId': source['id'], 'title': title, 'heading': heading,
                           'url': source['url'], 'text': text})
            lines.clear()

    for node in nodes:
        # Site-wide recommendations are not the subject of this source page.
        unwanted_selector = '#cta-form, #reviews, .reviews-sec, .review-container, .pw-stats-section, .sidebar-form'
        if source['id'] != '5':
            unwanted_selector += ', [class*="related-"]'
        for unwanted in node.select(unwanted_selector):
            unwanted.decompose()
        if source['id'] == '5' and 'related-videos' in node.get('class', []):
            titles = [compact(x.get_text(' ', strip=True)) for x in node.select('h3')]
            for offset in range(0, len(titles), 15):
                flush()
                heading = 'Video titles listed on the clinic page (not transcripts or clinical evidence)'
                lines.extend(titles[offset:offset + 15])
                flush()
            continue
        for kind, text in blocks(node):
            if kind == 'heading':
                flush()
                heading = text
                if banner and heading.lower().startswith('cost of'):
                    lines.append(compact(banner.get_text(' ', strip=True)))
            else:
                for part in re.split(r'(?<=[.!?])\s+(?=.{300})', text) if len(text) > 2200 else [text]:
                    if sum(map(len, lines)) + len(part) > 2200:
                        flush()
                    lines.append(part)
    flush()
    if sum(len(c['text']) for c in chunks) < 150:
        raise ValueError(f"Page {source['id']}: insufficient extracted content")
    return {'id': source['id'], 'url': source['url'], 'title': title,
            'sha256': hashlib.sha256(raw.encode()).hexdigest(), 'chunks': chunks}


class AllowlistRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed):
        self.allowed = allowed

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if newurl not in self.allowed:
            raise ValueError('Redirect outside exact source allowlist')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cached', action='store_true', help='Re-extract local development snapshots; no network')
    args = parser.parse_args()
    sources = json.loads((ROOT / 'sources.json').read_text())
    assert len(sources) == 7 and len({s['url'] for s in sources}) == 7
    assert all(s['url'].startswith(ORIGIN + '/') for s in sources)
    opener = urllib.request.build_opener(AllowlistRedirect({s['url'] for s in sources} | {ORIGIN + '/robots.txt'}))
    robots = urllib.robotparser.RobotFileParser()
    if not args.cached:
        with opener.open(urllib.request.Request(ORIGIN + '/robots.txt', headers={'User-Agent': UA}), timeout=30) as response:
            robots.parse(response.read().decode().splitlines())
    pages = []
    for source in sources:
        cache = ROOT / '.cache' / (source['id'] + '.html')
        if args.cached:
            raw = cache.read_text()
        else:
            if not robots.can_fetch(UA, source['url']):
                raise ValueError(f"Robots disallows source {source['id']}")
            time.sleep(max(3.1, robots.crawl_delay(UA) or 0))
            with opener.open(urllib.request.Request(source['url'], headers={'User-Agent': UA}), timeout=35) as response:
                if 'text/html' not in response.headers.get('Content-Type', ''):
                    raise ValueError('Expected HTML')
                raw = response.read(3_000_001).decode('utf-8')
                if len(raw.encode()) > 3_000_000:
                    raise ValueError('Page too large')
            cache.parent.mkdir(exist_ok=True)
            cache.write_text(raw)
        pages.append(extract(raw, source))
        print(f"{source['id']}: {len(pages[-1]['chunks'])} chunks", flush=True)
    version = hashlib.sha256(json.dumps(pages, sort_keys=True).encode()).hexdigest()[:16]
    snapshot = {'version': version, 'fetchedAt': datetime.now(timezone.utc).isoformat(),
                'sources': [{k: v for k, v in p.items() if k != 'chunks'} for p in pages],
                'chunks': [c for p in pages for c in p['chunks']]}
    output = ROOT / 'knowledge.json'
    temporary = output.with_suffix('.tmp')
    temporary.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(output)
    print('Published snapshot', version)


if __name__ == '__main__':
    main()
