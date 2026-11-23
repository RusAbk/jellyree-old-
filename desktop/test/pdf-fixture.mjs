// A tiny, deterministic two-page PDF. No generated binary fixture or PDF tooling required.
export function pdfFixture() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    "",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, page] of [
    [3, 1],
    [5, 2],
  ]) {
    const stream = `0.4 0.2 0.7 rg 50 650 300 40 re f\n0 g BT /F1 24 Tf 50 730 Td (Jellyree PDF page ${page}) Tj ET\n`;
    objects[index] =
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;
  }
  let data = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(data));
    data += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  data += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  data += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return [...Buffer.from(data)];
}
