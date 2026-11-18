// Quick self-check with made-up data:  node test/check.js
// Expected values were confirmed against the original Python tool.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const PDFLib = require("../public/vendor/pdf-lib.min.js");
const C = require("../public/converter.js");

(async () => {
  const csv = fs.readFileSync(path.join(__dirname, "sample.csv"), "utf8");
  const template = fs.readFileSync(path.join(__dirname, "../public/template.pdf"));
  const invoices = await C.generateInvoices(PDFLib, csv, template);

  assert.deepStrictEqual(invoices.map((i) => i.filename), [
    "Keuler_Mary_2026-06.pdf",
    "Sample_Alice_2026-03.pdf",
    "Sample_Alice_2026-04.pdf",
    "Testperson_Bob_2026-05_pt1.pdf",
    "Testperson_Bob_2026-05_pt2.pdf",
  ]);

  const fields = async (inv) => {
    const form = (await PDFLib.PDFDocument.load(inv.pdfBytes)).getForm();
    return (name) => form.getTextField(name).getText() || "";
  };

  // Per-client override: hourly units at the fixed rate, amount recomputed.
  let f = await fields(invoices[0]);
  assert.deepStrictEqual(
    [f("row1_units"), f("row1_rate"), f("row1_unittype"), f("row1_amount"), f("total_amount")],
    ["2.5", "$35.00", "1 hr", "$87.50", "$87.50"]
  );

  // Same-day visits merged; zero-hour row dropped; 15-minute units.
  f = await fields(invoices[1]);
  assert.deepStrictEqual(
    [f("participant_name"), f("row1_date"), f("row1_modifier"), f("row1_units"), f("row1_rate"), f("row1_amount")],
    ["Sample, Alice", "03/03/26", "U1", "15", "$9.00", "$135.00"]
  );
  assert.deepStrictEqual([f("row2_date"), f("row3_date"), f("total_units"), f("total_amount")],
    ["03/10/26", "", "31", "$279.00"]);

  // More than 9 dates overflows to a second page; half-cent and half-unit
  // ties round to even, as in the original ($9.125 -> $9.12, 2.5 -> 2).
  f = await fields(invoices[3]);
  assert.deepStrictEqual([f("row9_date"), f("row1_rate"), f("total_units")], ["05/09/26", "$9.12", "36"]);
  f = await fields(invoices[4]);
  assert.deepStrictEqual([f("row1_date"), f("row1_units"), f("row2_date"), f("total_amount")],
    ["05/10/26", "2", "", "$22.81"]);

  assert.throws(() => C.planInvoices("Client,Visit Date,Billable Hours\nA B,01/05/2026,2\n"));
  assert.strictEqual(C.planInvoices("Client,Visit Date,Billable Hours\nA B,01/05/26,0\n").length, 0);
  console.log("All checks passed (" + invoices.length + " invoices).");
})().catch((e) => { console.error(e); process.exit(1); });

// ---- iLIFE IRIS Vendor Claim Form (also confirmed against the Python) ----
(async () => {
  const csv = fs.readFileSync(path.join(__dirname, "sample.csv"), "utf8");
  const template = fs.readFileSync(path.join(__dirname, "../public/ilife_template.pdf"));
  const claims = await C.generateClaims(PDFLib, csv, template, {
    invoiceNumber: "INV-001",
    invoiceDate: { year: 2026, month: 7, day: 9 },
  });
  // 14 lines per page, so ten dates fit on one page here.
  assert.deepStrictEqual(claims.map((c) => c.filename), [
    "ilife_Keuler_Mary_2026-06.pdf",
    "ilife_Sample_Alice_2026-03.pdf",
    "ilife_Sample_Alice_2026-04.pdf",
    "ilife_Testperson_Bob_2026-05.pdf",
  ]);
  const form = (await PDFLib.PDFDocument.load(claims[1].pdfBytes)).getForm();
  const f = (name) => form.getTextField(name).getText() || "";
  assert.deepStrictEqual(
    [f("PPT_First_Name"), f("PPT_Last_Name"), f("Invoice Number"), f("Invoice Date")],
    ["Alice", "Sample", "INV-001", "07-09-2026"]
  );
  assert.deepStrictEqual(
    [f("Billing Start Date"), f("undefined"), f("undefined_2"), f("Billing End Date"), f("undefined_3")],
    ["03", "03", "2026", "03", "10"]
  );
  assert.deepStrictEqual(
    [f("Service CodeRow1"), f("Text-19"), f("Service From Date MMDDYYYY"), f("Description"),
     f("Unit Type each mile HR"), f("Rate"), f("Units"), f("Billed Amount"), f("Billed AmountTotal")],
    ["S5125", "U1", "03-03-2026", "Supportive Home Care", "15 min", "$9.00", "15", "$135.00", "$279.00"]
  );
  assert.deepStrictEqual([f("Provider Name 1"), f("Vendor ID"), f("PPT_Medicaid_ID"), f("Text18")],
    [C.DEFAULT_PROVIDER.name, "", "", ""]);

  const hr = C.planClaims(csv, { unitBasis: C.UNIT_BASIS_HOUR })[1].fieldValues;
  assert.deepStrictEqual([hr["Unit Type each mile HR"], hr["Rate"], hr["Units"]], ["HR", "$36.00", "3.75"]);
  assert.deepStrictEqual(C.splitParticipantName("Sample, Alice Q"), ["Alice", "Q", "Sample"]);
  assert.deepStrictEqual(C.splitParticipantName("Alice Q Sample"), ["Alice", "Q", "Sample"]);
  console.log("iLIFE checks passed (" + claims.length + " claims).");
})().catch((e) => { console.error(e); process.exit(1); });
