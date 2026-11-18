# AxisCare → IRIS Billing Form Converter

A small web page. Choose an AxisCare `ClaimBatchCreation` CSV; get back filled
IRIS billing PDFs (one PDF, or a ZIP of several).

| Form | Template | Lines per page |
| --- | --- | --- |
| GT Independence IRIS Provider Invoice | `public/template.pdf` | 9 |
| iLIFE IRIS Vendor Claim Form (rev. 3/2026) | `public/ilife_template.pdf` | 14 |

Pick one or **Both** on the page. With *Both*, each participant-month is emitted
on both forms; iLIFE filenames are prefixed `ilife_`.

It runs on Cloudflare Pages. The CSV is read and the PDFs are built **inside the
browser tab** — the file is never uploaded, stored, or sent anywhere.

## Behavior

- One form per **participant per calendar month** (grouped by `Visit Date`).
- Multiple CSV rows for the same participant on the same date are **merged** into
  a single line (billable hours and amounts summed).
- If a (participant, month) group has more distinct service dates than the form
  has lines, it is split into `..._pt1.pdf`, `..._pt2.pdf`, …; each part is one
  printable page and carries its own totals.
- `Unit Type` is reported as `15 min`. Units are computed as
  `billable_hours × 4`, and `Unit Rate` is `csv_rate / 4` (e.g. $36/hr → $9.00).
  The iLIFE form can be switched to bill in `HR` (hours at the CSV hourly rate).
- Rows with no client, or with zero/blank billable hours, are skipped.
- `Visit Date` must be `MM/DD/YY` (two-digit year), as AxisCare exports it.
- Download names are generic (`iris_form_xxxxxxxx.pdf` /
  `iris_forms_xxxxxxxx.zip`); the uploaded file's name is never reused.

CSV columns used: `Client`, `Visit Date`, `Procedure Code`, `Modifiers`,
`Billable Hours`, `Billable Rate`, `Billable Amount`. Other columns are ignored.

### iLIFE Vendor Claim Form specifics

Provider details default to the same provider baked into `template.pdf`
(`DEFAULT_PROVIDER` in `public/converter.js`) and can be edited on the page for
each run. The form asks for at least one of Provider ID (SSN/EIN), **Vendor ID**
(iLIFE-assigned), or **Medicaid ID** (ForwardHealth-assigned); only the EIN is
pre-filled, so type the Vendor ID and/or Medicaid ID if they have been issued.

- **Participant first / middle / last** — split from the CSV `Client` column
  (handles both `Last, First M` and `First M Last`).
- **Participant Medicaid ID and DOB** — read from the CSV only if it has a
  matching column (`Medicaid ID`, `Member ID`, `Insurance ID`, `DOB`,
  `Date of Birth`, …). Left blank otherwise.
- **Billing Start/End Date** — first and last service date on that page.
- **Service rows** — one row per service date, From = To = that date;
  `Description` is typed on the page (default `Supportive Home Care`).
- **Signature lines and Invoice Number** — left blank for hand-completion
  (Invoice Number can be typed on the page).
- The per-client billing overrides below apply to the IRIS Provider Invoice
  only, **not** to the iLIFE form.

Check a generated claim against the iLIFE form instructions before the first
submission.

### Per-client billing overrides

Some clients must be billed differently than the source CSV reports, **without
editing the CSV**. `CLIENT_OVERRIDES` near the top of `public/converter.js` maps
a client name (matched case-insensitively against the CSV `Client` column, with
`Last, First` reordered so both name orders match) to a billing override. When a
client matches, the invoice uses the override's unit type and fixed hourly rate
instead of the 15-min default, and the line **amount is recomputed** as
`billable_hours × hourly_rate` so `rate × units` reconciles.

> **Anything in `CLIENT_OVERRIDES` is part of the web page**, so anyone who can
> open the site can read it. Do not put a real participant's name there unless
> the site is behind the password below or Cloudflare Access.

## Deploying on Cloudflare Pages

Connect this repository in the Cloudflare dashboard (Workers & Pages → Create →
Pages → Connect to Git) with:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | *(leave empty)* |
| Build output directory | `public` |
| Root directory | *(leave empty)* |

No bindings, databases, or other services are needed.

### Optional password

If the Pages project has a secret named `APP_PASSWORD` (Settings → Variables
and Secrets), the browser asks for a password before showing the page. The user
name box can be left blank; only the password is checked. With no `APP_PASSWORD`
the site is open to anyone with the link. Redeploy after adding or changing it.

## Privacy notes

This tool handles PHI (participant names, dates of service).

- Processing is in the browser only. Nothing from the CSV reaches Cloudflare or
  any other server, and nothing is written to disk except the file you download.
- The page loads no outside scripts, fonts, or analytics, and its security
  headers (`public/_headers`) block it from contacting other sites.
- Errors never repeat CSV contents back.
- This does not by itself settle whether the hosting meets your organisation's
  policy — check with IT/compliance before using it with real files.

## Run / test locally

    npx wrangler pages dev public     # then open the address it prints
    node test/check.js                # self-check using made-up data

## Files

- `public/index.html` — the page
- `public/converter.js` — CSV parsing, grouping, PDF fill, ZIP
- `public/template.pdf` — IRIS Provider Invoice fillable PDF (pre-filled with provider info)
- `public/ilife_template.pdf` — iLIFE IRIS Vendor Claim Form, unmodified from ilife.org
- `public/vendor/pdf-lib.min.js` — [pdf-lib](https://pdf-lib.js.org/) 1.17.1 (MIT), bundled so nothing loads from the internet
- `public/fonts/` — Inter and Space Grotesk (SIL Open Font License), bundled so the page matches the RCM Portal without loading fonts from the internet
- `public/_headers` — security headers
- `functions/_middleware.js` — the optional password gate
- `test/` — made-up sample CSV and a self-check

The original Python/Streamlit version is in the git history (IRIS invoice last
at commit `6a3c151`, iLIFE form at `f815fa2`); this version was checked to
produce the same field values as both.
