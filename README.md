# E-Commerce Price Tracker & Monitor

Checks competitor product pages on a schedule, keeps every price in SQLite and alerts you the moment a competitor discounts, undercuts you, sells out or hits a target price. Sends alerts to Telegram, Slack, Discord, email or any webhook, and produces Excel / HTML reports for clients.

**Stack:** JavaScript (Node.js ESM) — a scraper + cron job + CLI is the default JS case: Puppeteer is Node-native and there is no build step.
Puppeteer Stealth · node-cron · SQLite (built-in `node:sqlite`, no native build) · cheerio · exceljs · optional AI fallback over the multi-model router.

```
watchlist (SQLite) ──► scheduler (node-cron) ──► per-store polite queue
                                                   │
          ┌────────────────────────────────────────┘
          ▼
  1. Shopify product JSON  (/products/<handle>.js — exact price, compare-at, stock)
  2. plain HTTP + extractors  ── fast path, no browser
  3. Puppeteer Stealth Chrome + same extractors  ── JS-rendered pages, bot walls
  4. AI reads the page text (optional; rejected unless the price is on the page)
          │
          ▼
  sanity checks (huge drop re-read, currency change) ──► store reading ──► alert rules ──► dedupe ──► channels
                                                                                                   └► reports
```

Extractors, most reliable first: your CSS selector → JSON-LD (schema.org Product/Offer) → microdata → Open Graph / product meta tags → known stores (Amazon, eBay, Walmart, Best Buy, Target, AliExpress, Noon, Etsy) and platform themes (Shopify, WooCommerce, Magento, BigCommerce, PrestaShop) → generic "price" heuristic (marked low confidence).

## Quick start

```bash
npm install                       # also downloads Chrome for Puppeteer
node bin/price-tracker.js demo    # offline: 5 fake competitor stores, 3 days of price changes, all alert types, reports in data/
cp .env.example .env              # add Telegram / Slack / ... (all optional)

node bin/price-tracker.js test-url "https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"
node bin/price-tracker.js add <competitor-url> --sku earbuds-pro --own-price 115 --target 99
node bin/price-tracker.js import examples/products.example.json     # or a CSV exported from Excel (; or ,)
node bin/price-tracker.js check                                      # one run now
node bin/price-tracker.js start --run-now                            # daemon: CHECK_CRON (default daily 08:00)
node bin/price-tracker.js report                                     # data/report.xlsx + data/report.html
```

`npm link` makes it available as `price-tracker` everywhere.

## Commands

| Command | What it does |
|---|---|
| `add <url> [--name --sku --target --own-price --selector --stock-selector --engine --currency --drop-pct --tags]` | Track a product. Same URL again = update. |
| `import <file.json\|file.csv>` / `export [file]` | Bulk add/update; CSV headers: `url,name,sku,target_price,own_price,selector,stock_selector,engine,currency,drop_pct,tags`. European numbers (`49,90`) are fine. |
| `list`, `edit <id> ...`, `enable/disable/remove <id>` | Manage the watchlist. |
| `test-url <url> [--selector]` | Read one page now and show which engine/extractor found the price. Use it before adding a new store. |
| `check [--id 1,2] [--dry-run] [--no-notify] [--engine]` | One run. `--dry-run` saves and sends nothing. |
| `start [--cron "..."] [--run-now] [--health-port 8080]` | Scheduler daemon with `/health`. |
| `history <id>` | Price history with sparkline. |
| `compare [sku]` | Same product at all competitors: cheapest store, gap and your rank. |
| `alerts` | Recent alerts and where they were sent. |
| `report [--format xlsx,html,csv,json] [--out data/report] [--sep ";"]` | Excel (Prices, Market, Alerts, Price history sheets, clickable links), HTML dashboard, CSV, JSON. |
| `notify-test` | Sample alert to every configured channel. |
| `doctor [--ping]` | Database, schedule, Chrome launch, channels, AI models. |

## Alerts

| Type | Fires when |
|---|---|
| `price_drop` | price fell ≥ `DROP_PCT` % (or `DROP_AMOUNT`) since the last check; per-product `--drop-pct` |
| `sale_started` | a "was / compare-at" price appears with ≥ `MIN_SALE_PCT` % off (or the sale gets deeper) |
| `target_reached` | price crosses down to your `--target` |
| `all_time_low` | lowest price ever recorded for that product |
| `undercut` | competitor goes below your `--own-price` (shows gap and your rank in the SKU group) |
| `back_in_stock` / `out_of_stock` | stock changes (sold out = chance to hold or raise your price) |
| `price_increase` | rise ≥ `INCREASE_PCT` % (off by default) |
| `tracker_failing` | a product failed `FAIL_ALERT_AFTER` checks in a row (blocked, removed, layout change) — sent once |

Noise control: one message per product per run with every reason in it, a cooldown for the same alert and price (`ALERT_COOLDOWN_HOURS`), drops ≥ `SUSPICIOUS_DROP_PCT` are re-read and only trusted if both readings agree, and readings whose currency suddenly changes (geo redirect) are skipped.

The webhook channel sends JSON (`types`, `product`, `price`, `previous_price`, `list_price`, `market`, `events`) for Zapier / Make / n8n, a Google Sheet or an automatic repricer.

## Scraping politely and reliably

- Pages of the same store are fetched one at a time with a randomised `DOMAIN_DELAY_MS` gap; different stores run in parallel (`CONCURRENCY`).
- `robots.txt` is respected by default (`RESPECT_ROBOTS`).
- Chrome only launches when needed and remembers per product when HTTP was not enough (`learned_engine`), so daily runs stay fast. Images, fonts and media are blocked in the browser.
- Bot walls (Cloudflare "Just a moment", captchas, DataDome, PerimeterX, 403/429) are detected and reported as `blocked`, never stored as a price.
- **Amazon, Best Buy and similar sites block datacenter and home IPs fast.** Stealth alone is not enough there: use `PROXY_URL` with a residential proxy, a slower schedule, or the store's official API / affiliate feed. Tested Nov 2026: Amazon returned a captcha to both HTTP and stealth Chrome from a home IP; books.toscrape, scrapeme.live (WooCommerce), webscraper.io, Allbirds (headless Shopify) and IKEA all read via HTTP in 1–2.5 s.
- Only monitor public product pages, follow each site's terms, and don't log in or collect personal data.

### When a store isn't read correctly

1. `test-url <url>` shows each try (`api → http 403 blocked → browser 200 ok`).
2. `confidence low` or `no price` → open the page, right-click the price → Inspect, and add `--selector ".product-price .current"` (or `"#el@data-price"` to read an attribute). Add `--stock-selector` for stock text.
3. Needs JavaScript → `--engine browser`. Blocked in Chrome too → `PROXY_URL`.
4. Optional: set any AI key (Gemini, Groq, NVIDIA, OpenRouter, Ollama) and the AI reads the price from the page text when everything else fails; the answer is rejected unless that exact price appears on the page.

## Deploy

- **Docker:** `docker compose up -d --build` (system Chromium, data in `./data`, `/health` on 8080). Add products with `docker compose run --rm price-tracker import examples/products.example.json`.
- **Windows PC / VPS without Docker:** `npm ci`, then `node bin/price-tracker.js start` under pm2 (`pm2 start bin/price-tracker.js --name prices -- start`) or Task Scheduler running `check` daily.
- **As a library:** `import { openDb, runCheck, scrapeProduct, writeReports } from './src/index.js'`.

## Tests

`npm test` — 43 tests, no internet and no keys: price parsing (US/EU/CH/JP formats), every extractor, Shopify JSON, alert rules, SQLite store, robots.txt, CSV import, a 3-day monitor run over local fake stores (dedupe, failure alerts, huge-drop re-read, dry run), every notification channel payload, the AI hallucination guard, the CLI end to end, and a real stealth Chrome reading a JavaScript-only price (skipped if Chrome is missing; `SKIP_BROWSER_TESTS=1` to skip).

## Project layout

```
bin/price-tracker.js      CLI entry
src/cli.js                commands
src/monitor.js            one run: polite queue, sanity checks, alerts, notify
src/scraper.js            engine chain for one URL
src/extract/              JSON-LD, microdata, meta, site rules, heuristics
src/fetch/                http, robots.txt, Shopify JSON, stealth browser pool
src/alerts.js             alert rules + market position
src/notify/               Telegram, Slack, Discord, email (Resend), webhook
src/report.js             xlsx / html / csv / json
src/db.js                 SQLite schema and queries
src/scheduler.js          node-cron daemon + /health
src/ai/ + ai-extract.js   multi-model fallback router, guarded AI price reading
src/demo.js               offline fake stores
```

## License

MIT
