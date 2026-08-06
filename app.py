"""Streamlit app: upload an AxisCare CSV → download filled IRIS invoice PDFs.

HIPAA posture (code-level):
- All processing is in-memory; uploaded CSV bytes and generated PDFs are never
  written to disk by this app.
- No third-party network calls, no analytics, no external assets.
- Optional shared-password gate via APP_PASSWORD env var / Streamlit secret.
- Generic download filenames — never echoes uploaded filename back (it may
  contain PHI).
- Errors never include CSV contents.

Operational pieces (TLS termination, BAA with hosting provider, access control,
log forwarding) are deployment-time concerns. NOTE: Streamlit Community Cloud
does not currently sign BAAs and is not suitable for PHI. Host this on
infrastructure with which you have signed a BAA (a private Streamlit
deployment on AWS/Azure/GCP under a BAA, or self-hosted on hardened
infrastructure) — see README.
"""

from __future__ import annotations

import hmac
import io
import os
import secrets
import zipfile
from dataclasses import replace
from datetime import date
from pathlib import Path

import streamlit as st

import ilife_claim
from invoice_generator import generate_invoices

BASE_DIR = Path(__file__).parent
TEMPLATE_PDF = BASE_DIR / "template.pdf"
ILIFE_TEMPLATE_PDF = BASE_DIR / "ilife_template.pdf"
MAX_UPLOAD_BYTES = 5 * 1024 * 1024

FORM_IRIS_INVOICE = "IRIS Provider Invoice"
FORM_ILIFE_CLAIM = "iLIFE IRIS Vendor Claim Form"
FORM_BOTH = "Both"
FORM_CHOICES = (FORM_IRIS_INVOICE, FORM_ILIFE_CLAIM, FORM_BOTH)


def _expected_password() -> str | None:
    pw = os.environ.get("APP_PASSWORD")
    if pw:
        return pw
    try:
        return st.secrets.get("APP_PASSWORD")  # type: ignore[attr-defined]
    except (FileNotFoundError, KeyError, AttributeError):
        return None


def _check_password() -> bool:
    expected = _expected_password()
    if not expected:
        return True
    if st.session_state.get("authed"):
        return True

    st.title("AxisCare → IRIS billing forms")
    st.write("Enter the access password to continue.")
    entered = st.text_input("Password", type="password", key="pw_input")
    if st.button("Sign in"):
        if hmac.compare_digest(entered or "", expected):
            st.session_state["authed"] = True
            st.rerun()
        else:
            st.error("Incorrect password.")
    return False


def _ilife_options() -> ilife_claim.ClaimOptions:
    """Collect the iLIFE fields that the AxisCare CSV cannot supply."""
    default = ilife_claim.SYNERGY_MADISON
    with st.expander("iLIFE claim details", expanded=True):
        col1, col2 = st.columns(2)
        with col1:
            provider_name = st.text_input("Provider name", value=default.name)
            provider_id = st.text_input(
                "Provider ID (SSN or EIN)",
                value=default.provider_id,
                help="Include at least one of Provider ID / Vendor ID / Medicaid ID.",
            )
            vendor_id = st.text_input(
                "Vendor ID", value=default.vendor_id, help="iLIFE-assigned ID number."
            )
            medicaid_id = st.text_input(
                "Medicaid ID",
                value=default.medicaid_id,
                help="ForwardHealth-assigned provider number.",
            )
            contact_person = st.text_input(
                "Provider contact person", value=default.contact_person
            )
        with col2:
            phone = st.text_input("Phone", value=default.phone)
            street = st.text_input("Address (street)", value=default.address_street)
            city_state_zip = st.text_input(
                "Address (city, state, ZIP)", value=default.address_city_state_zip
            )
            invoice_number = st.text_input("Invoice number", value="")
            description = st.text_input(
                "Service description", value="Supportive Home Care"
            )

        col3, col4 = st.columns(2)
        with col3:
            unit_basis = st.radio(
                "Unit basis",
                (ilife_claim.UNIT_BASIS_15MIN, ilife_claim.UNIT_BASIS_HOUR),
                horizontal=True,
                help="15 min matches the IRIS Provider Invoice (rate ÷ 4). HR bills "
                "hours at the CSV hourly rate.",
            )
        with col4:
            include_invoice_date = st.checkbox("Set invoice date", value=True)
            invoice_date = (
                st.date_input("Invoice date", value=date.today())
                if include_invoice_date
                else None
            )

    provider = replace(
        default,
        name=provider_name,
        address_street=street,
        address_city_state_zip=city_state_zip,
        contact_person=contact_person,
        phone=phone,
        provider_id=provider_id,
        vendor_id=vendor_id,
        medicaid_id=medicaid_id,
    )
    return ilife_claim.ClaimOptions(
        service_description=description,
        unit_basis=unit_basis,
        invoice_number=invoice_number,
        invoice_date=invoice_date,
        provider=provider,
    )


def _render_app() -> None:
    st.set_page_config(
        page_title="AxisCare → IRIS billing forms",
        page_icon=None,
        layout="centered",
    )

    st.title("AxisCare → IRIS billing forms")
    st.write(
        "Upload an AxisCare **ClaimBatchCreation** CSV. You'll get back one filled "
        "PDF per participant per service month, on the form you pick below."
    )

    form_choice = st.radio("Form", FORM_CHOICES, horizontal=True)
    claim_options = (
        _ilife_options() if form_choice in (FORM_ILIFE_CLAIM, FORM_BOTH) else None
    )

    with st.expander("Rules", expanded=False):
        st.markdown(
            "- One form per participant per calendar month.\n"
            "- Same-day visits for a participant are merged into a single line.\n"
            "- Service dates per page: **9** on the IRIS Provider Invoice, **14** on "
            "the iLIFE Vendor Claim Form. Longer months overflow into "
            "`_pt2`, `_pt3`, …\n"
            "- Units default to 15-minute increments at the equivalent unit rate.\n"
            "- On the iLIFE form, signature lines and any ID the CSV doesn't carry "
            "are left blank for hand-completion."
        )

    st.warning(
        "This tool handles Protected Health Information (PHI). Uploaded files "
        "are processed entirely in memory and are not written to disk or sent "
        "to any third party. Do not share generated PDFs outside of authorized "
        "billing workflows."
    )

    upload = st.file_uploader(
        "AxisCare CSV",
        type=["csv"],
        accept_multiple_files=False,
        help="Max 5 MB.",
    )

    if upload is None:
        return

    raw = upload.getvalue()
    if len(raw) > MAX_UPLOAD_BYTES:
        st.error("File is too large (max 5 MB).")
        return

    try:
        try:
            csv_text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            csv_text = raw.decode("latin-1")
    except UnicodeDecodeError:
        st.error("CSV file is not valid text.")
        return

    try:
        invoices = []
        if form_choice in (FORM_IRIS_INVOICE, FORM_BOTH):
            invoices += generate_invoices(csv_text, TEMPLATE_PDF)
        if form_choice in (FORM_ILIFE_CLAIM, FORM_BOTH):
            invoices += ilife_claim.generate_claims(
                csv_text, ILIFE_TEMPLATE_PDF, claim_options
            )
    except Exception:
        st.error("Could not process CSV. Check the file format and try again.")
        return
    finally:
        del csv_text
        del raw

    if not invoices:
        st.error("No billable rows found in the CSV.")
        return

    token = secrets.token_hex(4)

    if len(invoices) == 1:
        only = invoices[0]
        st.success("Generated 1 form.")
        st.download_button(
            label="Download PDF",
            data=only.pdf_bytes,
            file_name=f"iris_form_{token}.pdf",
            mime="application/pdf",
        )
        return

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for inv in invoices:
            zf.writestr(inv.filename, inv.pdf_bytes)

    st.success(f"Generated {len(invoices)} forms.")
    st.download_button(
        label="Download ZIP",
        data=buf.getvalue(),
        file_name=f"iris_forms_{token}.zip",
        mime="application/zip",
    )

    with st.expander("Files in this ZIP"):
        for inv in invoices:
            st.text(inv.filename)


def main() -> None:
    if not _check_password():
        return
    _render_app()


if __name__ == "__main__":
    main()
else:
    # Streamlit imports the module rather than executing __main__; run on import.
    main()
