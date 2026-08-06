# AxisCare → IRIS Billing Form Converter

Streamlit app. Upload an AxisCare `ClaimBatchCreation` CSV; download a ZIP of
filled IRIS billing PDFs.

## Supported forms

| Form | Template | Lines per page |
| --- | --- | --- |
| IRIS Provider Invoice | `template.pdf` | 9 |
| [iLIFE IRIS Vendor Claim Form](https://ilife.org/wp-content/uploads/IRIS_Vendor_Claim_Form-with-Vendor-ID-fillable.pdf) (rev. 3/2026) | `ilife_template.pdf` | 14 |

Pick one or **Both** in the UI. With *Both*, each participant-month is emitted
on both forms; iLIFE filenames are prefixed `ilife_`.

## Behavior

- One form per **participant per calendar month** (grouped by `Visit Date`).
- Multiple CSV rows for the same participant on the same date are **merged** into
  a single line (billable hours and amounts summed).
- If a (participant, month) group has more distinct service dates than the form
  has lines, it is split into `..._pt1.pdf`, `..._pt2.pdf`, …; each part is one
  printable page and carries its own billing date range and page total.
- `Unit Type` is reported as `15 min`. Units are computed as
  `billable_hours × 4`, and `Unit Rate` is `csv_rate / 4` (e.g. $36/hr → $9.00).
  The iLIFE form can be switched to bill in `HR` (hours at the CSV hourly rate).

## iLIFE Vendor Claim Form specifics

Provider details default to **Synergy HomeCare of Madison** (the same details
baked into `template.pdf`), defined as `SYNERGY_MADISON` in `ilife_claim.py` and
editable per run in the UI:

    Provider Name        Synergy HomeCare of Madison
    Address              6320 Monona Dr. Ste 215, Madison, WI 53716
    Contact / Phone      Russell Bercier / 608-400-2941
    *Provider ID (EIN)   99-3982407

The form asks for at least one of Provider ID (SSN/EIN), **Vendor ID**
(iLIFE-assigned), or **Medicaid ID** (ForwardHealth-assigned). Only the EIN is
known from the existing data — enter the Vendor ID and/or Medicaid ID in the UI
if iLIFE has issued them.

Field sourcing:

- **Participant first / middle / last** — split from the CSV `Client` column
  (handles both `Last, First M` and `First M Last`).
- **Participant Medicaid ID and DOB** — read from the CSV only if it carries a
  matching column (`Medicaid ID`, `Member ID`, `Insurance ID`, `DOB`, …; see
  `MEDICAID_ID_COLUMNS` / `DOB_COLUMNS`). Left blank otherwise.
- **Billing Start/End Date** — first and last service date on that page.
- **Service rows** — one row per service date, From = To = that date;
  `Description` is a per-run value (default `Supportive Home Care`).
- **Signature lines and Invoice Number** — left blank for hand-completion
  (Invoice Number can be set in the UI).

Verify a generated claim against the
[form instructions](https://ilife.org/forms/iris-forms/) before the first
submission; submit via <https://ecm.mcfi.net/Forms/vendorclaims>, email
IRIS.Claims@iLIFE.org, or fax 1-414-918-8213.

## Run locally

    pip install -r requirements.txt
    streamlit run app.py
    # http://localhost:8501

To require a password, set `APP_PASSWORD`:

    APP_PASSWORD='strong-secret' streamlit run app.py

You can also put it in `.streamlit/secrets.toml`:

    APP_PASSWORD = "strong-secret"

## HIPAA compliance

This app processes PHI (participant names, member IDs, auth numbers, dates of
service). The code is structured to support a HIPAA-compliant deployment;
**compliance also requires operational controls that are not enforceable from
the code alone**.

### ⚠️ Streamlit Community Cloud is NOT HIPAA-eligible

As of this writing, **Streamlit Community Cloud (`*.streamlit.app`) does not
sign Business Associate Agreements**. Do not host this app there with real
PHI. Acceptable hosting options:

- **Self-hosted Streamlit** on a VM (AWS EC2, Azure VM, GCP Compute Engine,
  on-prem) under a BAA with the cloud provider, behind your own TLS-terminating
  reverse proxy and SSO/VPN.
- **Snowflake Streamlit** if your Snowflake account is on a HIPAA-eligible
  edition and a BAA is in place.
- **Containerized deployment** (Cloud Run, App Service, ECS, GKE) where the
  underlying service is BAA-eligible and configured per the provider's HIPAA
  guidance.

### Code-level controls (in this repo)

- All processing is **in-memory only**. The uploaded CSV and generated PDFs are
  never written to disk by the app. There are no temp files.
- **No third-party requests** — no analytics, no external CDNs, no fonts loaded
  from the internet.
- **Optional password gate** via `APP_PASSWORD` env var (or Streamlit secret).
- **Generic download filenames** — the uploaded filename (which can itself be
  PHI) is never reflected back in the response.
- **Errors never echo CSV contents back.**

### Operational controls (your responsibility to configure)

These must be true in production to claim HIPAA compliance:

1. **Sign a BAA** with your hosting provider and any other vendor that touches
   the traffic (load balancer, WAF, log aggregator, backup service).
2. **TLS everywhere.** Terminate HTTPS in front of Streamlit (reverse proxy,
   load balancer). Streamlit itself does not terminate TLS.
3. **Authentication.** Set a strong `APP_PASSWORD`, or front the app with SSO
   / your existing identity provider. Do not run open to the internet.
4. **Restrict access** to the host (security groups, VPN, IP allow-list) and
   the file system (least-privilege OS user).
5. **Disable usage telemetry.** Set `browser.gatherUsageStats = false` and
   `global.disableWatchdogWarning = true` in `.streamlit/config.toml` to keep
   the app from phoning home.
6. **Disable infrastructure logging of request bodies / file uploads.**
7. **Encrypt at rest.** The app does not write PHI to disk, but the host's
   disk should still be encrypted.
8. **Audit logging** at the reverse proxy / auth layer (login events, retain
   per policy). Streamlit itself does not emit auth-event logs.
9. **Patch management.** Keep `streamlit`, `pypdf`, and the OS base image
   current.
10. **Workforce training & policies** — sanctions for misuse, breach
    notification process, designated Privacy/Security Officer.

### Recommended `.streamlit/config.toml` for PHI hosting

    [server]
    headless = true
    enableCORS = false
    enableXsrfProtection = true

    [browser]
    gatherUsageStats = false

    [global]
    disableWatchdogWarning = true

### What this app does NOT do

- It does not authenticate individual users (only a single shared password).
  For multi-user environments, front it with SSO.
- It does not write an audit trail of which user processed which CSV.
- It does not validate that the uploader is authorized for the participants
  listed in the CSV.

If you need any of the above, treat this app as a building block, not a
turnkey HIPAA solution.

## Files

- `app.py` — Streamlit UI
- `invoice_generator.py` — CSV parsing, grouping, PDF fill, IRIS Provider Invoice
  field mapping (no UI deps)
- `ilife_claim.py` — iLIFE IRIS Vendor Claim Form field mapping (no UI deps)
- `template.pdf` — IRIS Provider Invoice fillable PDF (pre-filled with provider info)
- `ilife_template.pdf` — iLIFE IRIS Vendor Claim Form, unmodified from ilife.org
  (provider info is filled at generation time)
