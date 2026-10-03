"""Render PDFs and page contact sheets; read-only to final PDFs."""
from pathlib import Path
import pymupdf as fitz

out = Path("/tmp/bapjangbu-pdf-check")
out.mkdir(exist_ok=True)
for file in sorted(Path("output/pdf").glob("*.pdf")):
    doc = fitz.open(file)
    print(file.name, "pages:", len(doc), "text_chars:", sum(len(p.get_text()) for p in doc))
    assert all(len(p.get_text().strip()) > 20 for p in doc), f"Blank page: {file}"
    for i, page in enumerate(doc):
        page.get_pixmap(matrix=fitz.Matrix(1.2, 1.2)).save(out / f"{file.stem}-{i+1:02}.png")
        for block in page.get_text("dict")["blocks"]:
            if block["type"] != 0:
                continue
            x0,y0,x1,y1 = block["bbox"]
            assert x0 >= -1 and y0 >= -1 and x1 <= page.rect.width+1 and y1 <= page.rect.height+1, (file.name,i+1,block["bbox"])
    for start in range(0, len(doc), 8):
        sheet = fitz.open()
        p = sheet.new_page(width=600*4, height=880*2)
        for j in range(start, min(start+8, len(doc))):
            col, row = (j-start)%4, (j-start)//4
            p.insert_text((col*600+12,row*880+18), f"Page {j+1}", fontsize=16)
            p.show_pdf_page(fitz.Rect(col*600,row*880+25,(col+1)*600,(row+1)*880),doc,j)
        p.get_pixmap(matrix=fitz.Matrix(.65,.65)).save(out / f"{file.stem}-sheet-{start//8+1}.png")
