# RaportRBR v1.0
## System raportów produkcyjnych — Ready Bathroom

---

## 🚀 Wdrożenie na Railway — krok po kroku

### Krok 1 — GitHub

1. Wejdź na **github.com** → zaloguj się lub załóż konto
2. Kliknij **New repository** → nazwa: `raportrbr` → **Create**
3. Pobierz **GitHub Desktop**: https://desktop.github.com
4. W GitHub Desktop: **Add existing repository** → wskaż ten folder
5. Kliknij **Publish repository**

---

### Krok 2 — Railway

1. Wejdź na **railway.app** → zaloguj przez GitHub
2. Kliknij **New Project** → **Deploy from GitHub repo** → wybierz `raportrbr`
3. Railway wykryje Node.js automatycznie

### Dodaj bazę danych:
4. W projekcie kliknij **+ New** → **Database** → **PostgreSQL**
5. Railway doda `DATABASE_URL` automatycznie

### Ustaw zmienne środowiskowe:
6. Kliknij na aplikację → **Variables** → dodaj:
```
JWT_SECRET = raportrbr-twoj-sekretny-klucz-2024
NODE_ENV = production
SMTP_HOST = smtp.gmail.com
SMTP_PORT = 587
SMTP_SECURE = false
SMTP_USER = twoj@gmail.com
SMTP_PASS = haslo-aplikacji-gmail
```

---

### Krok 3 — Inicjalizacja bazy danych

1. W Railway kliknij na **PostgreSQL** → zakładka **Query**
2. Wklej i wykonaj zawartość pliku `backend/schema.sql`

To stworzy wszystkie tabele i doda 174 pracowników.

---

### Krok 4 — Gotowe!

Railway da Ci adres: `https://raportrbr-production.up.railway.app`

**Pierwsze logowanie:**
- Menedżer: kod `ADMIN`, hasło `admin1234` ← **zmień po pierwszym logowaniu!**
- Pracownik: np. `PLY157`, hasło `zmien123`

---

## 📧 Gmail — hasło aplikacji

1. Konto Google → Bezpieczeństwo → Weryfikacja dwuetapowa (włącz)
2. Konta Google → Bezpieczeństwo → Hasła aplikacji
3. Wybierz "Poczta" → wygeneruj → skopiuj 16-znakowe hasło do `SMTP_PASS`

---

## 💰 Koszty Railway
- Plan darmowy: 500h/miesiąc (wystarczy dla małej firmy)
- Plan Hobby (~5$/mies.): nieograniczony czas działania ← **zalecane dla produkcji**
