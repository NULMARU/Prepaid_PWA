"""안내서 PDF 검사 — 배포되는 docs/manuals/*.pdf를 읽기만 한다(PDF를 고치지 않는다).

사용법:  uv run --with pymupdf python harness/check-manual-pdfs.py

· 파일이 0개면 실패(예전엔 gitignore된 output/pdf의 옛 사본을 보고 있었다).
· 쪽마다 글자가 있어야 하고(빈 쪽 금지), 글 상자가 쪽 밖으로 나가면 안 된다.
· 쪽 그림과 8쪽 단위 대조표를 $TMPDIR/bapjangbu-pdf-check 에 남긴다(눈으로 확인용).
"""
import sys
import tempfile
from pathlib import Path

import pymupdf as fitz

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "manuals"
out = Path(tempfile.gettempdir()) / "bapjangbu-pdf-check"
out.mkdir(exist_ok=True)

files = sorted(SRC.glob("*.pdf"))
if not files:
    print(f"FAIL: {SRC.relative_to(ROOT)}에 PDF가 없습니다")
    sys.exit(1)

problems = []
for file in files:
    doc = fitz.open(file)
    print(f"{file.name}  pages: {len(doc)}  text_chars: {sum(len(p.get_text()) for p in doc)}")
    for i, page in enumerate(doc):
        if len(page.get_text().strip()) <= 20:
            problems.append(f"{file.name} {i+1}쪽: 빈 쪽")
        page.get_pixmap(matrix=fitz.Matrix(1.2, 1.2)).save(out / f"{file.stem}-{i+1:02}.png")
        for block in page.get_text("dict")["blocks"]:
            if block["type"] != 0:
                continue
            x0, y0, x1, y1 = block["bbox"]
            if not (x0 >= -1 and y0 >= -1 and x1 <= page.rect.width + 1 and y1 <= page.rect.height + 1):
                problems.append(f"{file.name} {i+1}쪽: 쪽 밖 글 상자 {tuple(round(v) for v in block['bbox'])}")
    for start in range(0, len(doc), 8):
        sheet = fitz.open()
        p = sheet.new_page(width=600 * 4, height=880 * 2)
        for j in range(start, min(start + 8, len(doc))):
            col, row = (j - start) % 4, (j - start) // 4
            p.insert_text((col * 600 + 12, row * 880 + 18), f"Page {j+1}", fontsize=16)
            p.show_pdf_page(fitz.Rect(col * 600, row * 880 + 25, (col + 1) * 600, (row + 1) * 880), doc, j)
        p.get_pixmap(matrix=fitz.Matrix(.65, .65)).save(out / f"{file.stem}-sheet-{start//8+1}.png")

for msg in problems:
    print("FAIL:", msg)
print(f"\nPDF {len(files)}개 확인 — 문제 {len(problems)}건 (쪽 그림: {out})")
sys.exit(1 if problems else 0)
