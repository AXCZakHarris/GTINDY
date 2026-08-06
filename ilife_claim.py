"""Fill the iLIFE **IRIS Vendor Claim Form** from the same AxisCare CSV.

Source form: https://ilife.org/wp-content/uploads/IRIS_Vendor_Claim_Form-with-Vendor-ID-fillable.pdf
(revision 3/2026, shipped in this repo as `ilife_template.pdf`).

Grouping matches the IRIS Provider Invoice path in `invoice_generator`: one claim
per participant per calendar month, same-day visits merged. The iLIFE grid holds
**14** service lines per page, so months with more distinct service dates overflow
into `_pt2`, `_pt3`, …

Fields the AxisCare CSV cannot supply (Vendor ID, ForwardHealth Medicaid ID,
invoice number, participant DOB when the export omits it) come from `ProviderProfile`
/ `ClaimOptions` or are left blank for hand-completion. Signature lines are always
left blank — the form is signed on paper.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

from invoice_generator import (
    GeneratedInvoice,
    ServiceLine,
    chunk_lines,
    fill_pdf,
    fmt_money,
    fmt_units,
    parse_client_details,
    parse_csv,
    safe_filename,
    split_participant_name,
)

LINES_PER_CLAIM = 14

UNIT_BASIS_15MIN = "15 min"
UNIT_BASIS_HOUR = "HR"

# The DOB boxes and the Modifiers column are ~20pt wide; at the template's default
# font a 4-digit year or a two-modifier string is clipped.
NARROW_FIELD_PT = 7.5


@dataclass
class ProviderProfile:
    """Billing provider block ("To be completed by provider")."""

    name: str
    address_street: str
    address_city_state_zip: str
    contact_person: str
    phone: str
    provider_id: str = ""  # *Provider ID — SSN or EIN
    vendor_id: str = ""  # **Vendor ID — iLIFE assigned
    medicaid_id: str = ""  # ***Medicaid ID — ForwardHealth assigned


# Synergy HomeCare of Madison — same provider details already baked into
# `template.pdf` for the IRIS Provider Invoice.
SYNERGY_MADISON = ProviderProfile(
    name="Synergy HomeCare of Madison",
    address_street="6320 Monona Dr. Ste 215",
    address_city_state_zip="Madison, WI 53716",
    contact_person="Russell Bercier",
    phone="608-400-2941",
    provider_id="99-3982407",  # EIN
    vendor_id="",  # iLIFE assigns this — fill in before submitting
    medicaid_id="",  # ForwardHealth provider number, if enrolled
)


@dataclass
class ClaimOptions:
    """Per-run values that are not derivable from the CSV."""

    service_description: str = "Supportive Home Care"
    unit_basis: str = UNIT_BASIS_15MIN
    invoice_number: str = ""
    invoice_date: date | None = None
    provider: ProviderProfile = field(default_factory=lambda: SYNERGY_MADISON)


def _fmt_date(value: datetime | date) -> str:
    return value.strftime("%m-%d-%Y")


def _split_date(value: datetime | date | None) -> tuple[str, str, str]:
    if value is None:
        return "", "", ""
    return value.strftime("%m"), value.strftime("%d"), value.strftime("%Y")


def _row_fields(index: int) -> dict[str, str]:
    """Field names for service-grid row `index` (1-based).

    The template names row 1 without a suffix and rows 2-14 with `_2`…`_14`;
    the Modifiers column is a separate, unlabeled `Text-19`…`Text-32` series.
    """
    suffix = "" if index == 1 else f"_{index}"
    return {
        "code": f"Service CodeRow{index}",
        "modifier": f"Text-{18 + index}",
        "from_date": f"Service From Date MMDDYYYY{suffix}",
        "to_date": f"Service To Date MMDDYYYY{suffix}",
        "description": f"Description{suffix}",
        "unit_type": f"Unit Type each mile HR{suffix}",
        "rate": f"Rate{suffix}",
        "units": f"Units{suffix}",
        "amount": f"Billed Amount{suffix}",
    }


def narrow_field_font_sizes() -> dict[str, float]:
    sizes = {"Text15": NARROW_FIELD_PT, "Text17": NARROW_FIELD_PT, "Text18": NARROW_FIELD_PT}
    for i in range(1, LINES_PER_CLAIM + 1):
        sizes[_row_fields(i)["modifier"]] = NARROW_FIELD_PT
    return sizes


def _units_and_rate(line: ServiceLine, unit_basis: str) -> tuple[str, str]:
    if unit_basis == UNIT_BASIS_HOUR:
        return fmt_units(line.hours), fmt_money(line.csv_hourly_rate)
    return fmt_units(line.units), fmt_money(line.unit_rate)


def build_field_values(
    lines: list[ServiceLine],
    participant: str,
    options: ClaimOptions,
    medicaid_id: str = "",
    dob: datetime | date | None = None,
) -> dict[str, str]:
    provider = options.provider
    first, middle, last = split_participant_name(participant)
    dob_month, dob_day, dob_year = _split_date(dob)

    start = min(line.visit_date for line in lines)
    end = max(line.visit_date for line in lines)
    start_month, start_day, start_year = _split_date(start)
    end_month, end_day, end_year = _split_date(end)

    values: dict[str, str] = {
        "Invoice Number": options.invoice_number,
        "Invoice Date": _fmt_date(options.invoice_date) if options.invoice_date else "",
        # Participant block
        "PPT_Medicaid_ID": medicaid_id,
        "Text15": dob_month,
        "Text17": dob_day,
        "Text18": dob_year,
        "PPT_First_Name": first,
        "Middle": middle,
        "PPT_Last_Name": last,
        # Billing provider dates (three boxes each: MM / DD / YYYY)
        "Billing Start Date": start_month,
        "undefined": start_day,
        "undefined_2": start_year,
        "Billing End Date": end_month,
        "undefined_3": end_day,
        "undefined_4": end_year,
        # Provider block
        "Provider Name 1": provider.name,
        "Provider Name 2": "",
        "Provider Address Street 1": provider.address_street,
        "Provider Address Street 2": "",
        "Provider Address City State ZIP 1": provider.address_city_state_zip,
        "Provider Address City State ZIP 2": "",
        "Provider Contact Person": provider.contact_person,
        "Phone": provider.phone,
        "Provider ID": provider.provider_id,
        "Vendor ID": provider.vendor_id,
        "Medicaid ID": provider.medicaid_id,
    }

    total_amount = 0.0
    for i, line in enumerate(lines, start=1):
        names = _row_fields(i)
        units, rate = _units_and_rate(line, options.unit_basis)
        values[names["code"]] = line.procedure_code
        values[names["modifier"]] = line.modifier
        # One row per service date, so From and To are the same day.
        values[names["from_date"]] = _fmt_date(line.visit_date)
        values[names["to_date"]] = _fmt_date(line.visit_date)
        values[names["description"]] = options.service_description
        values[names["unit_type"]] = options.unit_basis
        values[names["rate"]] = rate
        values[names["units"]] = units
        values[names["amount"]] = fmt_money(line.amount)
        total_amount += line.amount

    values["Billed AmountTotal"] = fmt_money(total_amount)
    return values


def generate_claims(
    csv_text: str,
    template_path: Path,
    options: ClaimOptions | None = None,
) -> list[GeneratedInvoice]:
    options = options or ClaimOptions()
    grouped = parse_csv(csv_text)
    client_details = parse_client_details(csv_text)

    results: list[GeneratedInvoice] = []
    for (client, year, month), lines in sorted(grouped.items()):
        details = client_details.get(client)
        chunks = chunk_lines(lines, LINES_PER_CLAIM)
        total_pages = len(chunks)
        for idx, chunk in enumerate(chunks, start=1):
            field_values = build_field_values(
                chunk,
                client,
                options,
                medicaid_id=details.medicaid_id if details else "",
                dob=details.dob if details else None,
            )
            pdf_bytes = fill_pdf(
                template_path, field_values, font_sizes=narrow_field_font_sizes()
            )
            base = f"ilife_{safe_filename(client)}_{year:04d}-{month:02d}"
            suffix = f"_pt{idx}" if total_pages > 1 else ""
            results.append(
                GeneratedInvoice(
                    filename=f"{base}{suffix}.pdf",
                    participant=client,
                    year=year,
                    month=month,
                    page_index=idx,
                    page_count=total_pages,
                    pdf_bytes=pdf_bytes,
                )
            )
    return results
