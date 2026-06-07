/*
  Przykladowy endpoint backendu dla importu AI map hali.

  To nie jest czesc index.html. Ten fragment trzeba dodac do prawdziwego
  serwera aplikacji, tam gdzie juz istnieja endpointy /api/login, /api/reports
  i /api/maps-layouts.

  Wymagany endpoint:
    POST /api/maps/import-photo

  Wejscie multipart/form-data:
    hall  - betonowanie | namiot1 | namiot2
    photo - zdjecie hali

  Odpowiedz JSON dla frontendu:
    {
      "items": [
        { "row": "F", "col": 2, "project": "5472", "product": 85 }
      ]
    }

  Logika AI/OCR zalezy od backendu. Najbezpieczniejszy schemat:
    1. backend odbiera zdjecie,
    2. wysyla je do modelu vision/OCR,
    3. wymusza zwrot tylko JSON,
    4. waliduje row/col/project/product,
    5. zwraca wynik do aplikacji,
    6. uzytkownik zatwierdza uklad w zakladce Mapy.
*/

const HALLS = {
  betonowanie: { rows: ["F", "E"], cols: 23, label: "Hala Betonowanie" },
  namiot1: { rows: ["F", "E", "D", "C", "B", "A"], cols: 22, label: "Namiot 1" },
  namiot2: { rows: ["F", "E", "D", "C", "B", "A"], cols: 22, label: "Namiot 2" }
};

function normalizeImportedCells(hallId, rawItems) {
  const hall = HALLS[hallId];
  if (!hall || !Array.isArray(rawItems)) return [];

  const byCell = new Map();
  for (const raw of rawItems) {
    const row = String(raw.row || "").trim().toUpperCase();
    const col = Number(raw.col ?? raw.column);
    const project = String(raw.project ?? raw.projectNo ?? raw.order ?? "").replace(/\D/g, "");
    const product = Number(String(raw.product ?? raw.productNo ?? raw.bathroom ?? raw.bathroomNo ?? "").replace(/\D/g, ""));

    if (!hall.rows.includes(row)) continue;
    if (!Number.isInteger(col) || col < 1 || col > hall.cols) continue;
    if (!project || !Number.isInteger(product) || product < 1) continue;

    byCell.set(`${row}-${col}`, { row, col, project, product });
  }

  return [...byCell.values()].sort((a, b) => {
    return HALLS[hallId].rows.indexOf(a.row) - HALLS[hallId].rows.indexOf(b.row) || a.col - b.col;
  });
}

async function analyzeHallPhotoWithAi({ hallId, imageBase64, mimeType }) {
  /*
    Tu podlacz prawdziwe AI/OCR.

    Prompt powinien wymuszac:
    - odczytaj tylko wpisy z kratek,
    - zwroc JSON bez komentarza,
    - kazdy wpis ma row, col, project, product,
    - ignoruj puste kratki, daty, tytuly i napisy BIURO.

    Przykladowy wynik z modelu:
    return [
      { row: "F", col: 2, project: "5472", product: 85 },
      { row: "E", col: 10, project: "5551", product: 213 }
    ];
  */
  void hallId;
  void imageBase64;
  void mimeType;
  throw new Error("Podlacz tutaj usluge AI/OCR i zwroc liste { row, col, project, product }.");
}

/*
  Przyklad dla Express + multer:

  import multer from "multer";
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

  app.post("/api/maps/import-photo", requireAuth, upload.single("photo"), async (req, res) => {
    try {
      const hallId = String(req.body.hall || "");
      if (!HALLS[hallId]) return res.status(400).json({ error: "Nieznana hala." });
      if (!req.file) return res.status(400).json({ error: "Brak zdjecia." });

      const raw = await analyzeHallPhotoWithAi({
        hallId,
        imageBase64: req.file.buffer.toString("base64"),
        mimeType: req.file.mimetype || "image/jpeg"
      });

      res.json({ items: normalizeImportedCells(hallId, raw) });
    } catch (err) {
      res.status(500).json({ error: err.message || "Nie udalo sie zaimportowac zdjecia." });
    }
  });
*/

module.exports = {
  HALLS,
  normalizeImportedCells,
  analyzeHallPhotoWithAi
};
