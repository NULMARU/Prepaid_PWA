"""Native HTML-to-PDF fallback for the owner's guide (no browser session).

DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib uv run --with weasyprint python harness/export-owner-pdf.py
Run check-manual-pdfs.py and visually inspect the rendered pages afterward.
"""
import re
from pathlib import Path
from urllib.parse import urljoin
from weasyprint import HTML, CSS

root = Path(__file__).resolve().parent.parent
source = root / "docs/manual-restaurant.html"
html = source.read_text()
def public_link(match):
    href = match.group(1)
    if href.startswith(("#", "http:", "https:", "mailto:")):
        return match.group(0)
    return 'href="' + urljoin("https://app.bapjangbu.com/docs/manual-restaurant.html", href) + '"'
# Only anchors are made public. The shared CSS stays a local file.
html = re.sub(r'<a\b[^>]*>', lambda m: re.sub(r'href="([^"]*)"', public_link, m.group(0)), html)
footer = CSS(string='@page { @bottom-center { content: counter(page) " / " counter(pages); font: 9pt sans-serif; color: #666; } }')
pdf = HTML(string=html, base_url=str(source.parent)).write_pdf(stylesheets=[footer])
for folder in ("output/pdf", "docs/manuals"):
    (root / folder / "밥장부-안내서-음식점-사장님.pdf").write_bytes(pdf)
print("Owner PDF regenerated:", len(pdf), "bytes")
