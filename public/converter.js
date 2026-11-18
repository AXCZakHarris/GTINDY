/*
 * AxisCare ClaimBatchCreation CSV -> filled IRIS Provider Invoice PDFs.
 *
 * Browser port of the original Python (invoice_generator.py). Everything runs
 * on the user's own computer: the CSV is never uploaded anywhere.
 *
 * Grouping rules:
 * - One invoice per (participant, calendar month of Visit Date).
 * - Several CSV rows on the same date for the same participant become one line.
 * - The template has 9 service lines; a (participant, month) group with more
 *   than 9 distinct service dates is split into several one-page invoices.
 *
 * The number handling below deliberately copies Python's behaviour (round half
 * to even, "%g" formatting) so the output matches the original tool exactly.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.IrisConverter = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var LINES_PER_PAGE = 9;
  var UNIT_TYPE_LABEL = "15 min";
  var UNITS_PER_HOUR = 4; // 15-minute units

  // Per-client billing overrides, keyed by a normalized client name (lowercased,
  // whitespace-collapsed, and with "Last, First" reordered to "first last").
  // When a client matches, the invoice bills in the configured unit type at the
  // fixed hourly rate instead of the global 15-min default, and the line amount
  // is recomputed as hours * hourly_rate so rate * units reconciles. This lets
  // us correct a client's billing without editing the source CSV.
  var CLIENT_OVERRIDES = {
    "mary keuler": {
      unitsPerHour: 1, // 1 unit = 1 hour (no 15-min split)
      unitTypeLabel: "1 hr",
      hourlyRate: 35.0,
    },
  };

  function normalizeClientName(client) {
    var name = (client || "").split(/\s+/).filter(Boolean).join(" ").toLowerCase();
    if (name.split(",").length === 2) {
      var parts = name.split(",");
      var last = parts[0].trim();
      var first = parts[1].trim();
      if (last && first) name = first + " " + last;
    }
    return name;
  }

  function clientOverride(client) {
    var key = normalizeClientName(client);
    return Object.prototype.hasOwnProperty.call(CLIENT_OVERRIDES, key)
      ? CLIENT_OVERRIDES[key]
      : null;
  }

  // ---- CSV -----------------------------------------------------------------

  // Same rules as Python's csv module (Excel dialect): comma separated, double
  // quotes around a field, "" for a literal quote, line breaks allowed inside
  // quotes. Blank lines produce no row.
  function parseCsvRows(text) {
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var atFieldStart = true;
    var lineHasContent = false;
    var n = text.length;

    function endRow() {
      if (lineHasContent) {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = "";
      atFieldStart = true;
      lineHasContent = false;
    }

    for (var i = 0; i < n; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c !== '"') field += c;
        else if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
        continue;
      }
      if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        endRow();
        continue;
      }
      lineHasContent = true;
      if (c === ",") {
        row.push(field);
        field = "";
        atFieldStart = true;
      } else if (c === '"' && atFieldStart) {
        inQuotes = true;
        atFieldStart = false;
      } else {
        field += c;
        atFieldStart = false;
      }
    }
    endRow();
    return rows;
  }

  // Like Python's csv.DictReader: first row is the header; a repeated header
  // name keeps the last column; short rows leave the missing columns undefined.
  function parseCsvDicts(text) {
    var rows = parseCsvRows(text);
    if (!rows.length) return [];
    var header = rows[0];
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var obj = {};
      for (var c = 0; c < header.length; c++) obj[header[c]] = rows[r][c];
      out.push(obj);
    }
    return out;
  }

  // ---- Parsing values ------------------------------------------------------

  function parseNumber(text) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
      throw new Error("Not a number");
    }
    return Number(text);
  }

  function parseMoney(text) {
    if (text === undefined || text === null) return 0;
    var cleaned = text.trim().replace(/\$/g, "").replace(/,/g, "");
    if (!cleaned) return 0;
    return parseNumber(cleaned);
  }

  function parseHours(text) {
    if (!text || !text.trim()) return 0;
    return parseNumber(text.trim());
  }

  // Visit dates are M/D/YY (two-digit year), as AxisCare exports them.
  function parseDate(text) {
    if (text === undefined || text === null) throw new Error("Missing Visit Date");
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(text.trim());
    if (!m) throw new Error("Bad date");
    var month = Number(m[1]);
    var day = Number(m[2]);
    var yy = Number(m[3]);
    var year = yy <= 68 ? 2000 + yy : 1900 + yy;
    var probe = new Date(Date.UTC(year, month - 1, day));
    if (
      month < 1 ||
      day < 1 ||
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      throw new Error("Bad date");
    }
    return { year: year, month: month, day: day, key: year * 10000 + month * 100 + day };
  }

  // ---- Python-compatible rounding and formatting ---------------------------

  // Python's round(): halves go to the nearest even whole number.
  function roundHalfEven(x) {
    var floor = Math.floor(x);
    var diff = x - floor;
    if (diff < 0.5) return floor;
    if (diff > 0.5) return floor + 1;
    return floor % 2 === 0 ? floor : floor + 1;
  }

  // Non-negative number -> string with exactly `decimals` decimals, exact ties
  // rounded to even (as Python's format() does; JS toFixed rounds ties up).
  function fixedHalfEven(abs, decimals) {
    var EXTRA = 25;
    var exact = abs.toFixed(decimals + EXTRA);
    var rest = exact.slice(exact.length - EXTRA);
    if (/^50*$/.test(rest)) {
      var truncated = exact.slice(0, exact.length - EXTRA);
      if (decimals === 0) truncated = truncated.replace(/\.$/, "");
      var lastDigit = Number(truncated[truncated.length - 1]);
      if (lastDigit % 2 === 0) return truncated;
    }
    return abs.toFixed(decimals);
  }

  function isNegative(value) {
    return value < 0 || Object.is(value, -0);
  }

  // Python: f"${value:,.2f}"
  function fmtMoney(value) {
    var s = fixedHalfEven(Math.abs(value), 2);
    var dot = s.indexOf(".");
    var whole = s.slice(0, dot).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return "$" + (isNegative(value) ? "-" : "") + whole + s.slice(dot);
  }

  // Python: str(int(value)) for whole numbers, otherwise f"{value:g}".
  function fmtUnits(value) {
    if (Number.isInteger(value)) return String(value);
    var abs = Math.abs(value);
    var exp = Number(abs.toExponential(20).split("e")[1]);
    var sign = isNegative(value) ? "-" : "";
    if (exp < -4 || exp >= 6) {
      var parts = abs.toExponential(5).split("e");
      var mant = parts[0].replace(/\.?0+$/, "");
      var e = Number(parts[1]);
      var digits = String(Math.abs(e));
      if (digits.length < 2) digits = "0" + digits;
      return sign + mant + "e" + (e < 0 ? "-" : "+") + digits;
    }
    var s = fixedHalfEven(abs, 5 - exp);
    if (s.indexOf(".") !== -1) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return sign + s;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function fmtDate(d) {
    return pad2(d.month) + "/" + pad2(d.day) + "/" + pad2(d.year % 100);
  }

  function safeFilename(name) {
    var s = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    return s || "invoice";
  }

  // ---- Grouping ------------------------------------------------------------

  // Returns [{client, year, month, lines: [...]}, ...] sorted by client, year,
  // month; each line is one service date.
  function parseCsv(csvText) {
    var rows = parseCsvDicts(csvText);
    var accum = new Map(); // client -> Map(dateKey -> line)

    rows.forEach(function (row) {
      var client = (row["Client"] || "").trim();
      if (!client) return;
      var date = parseDate(row["Visit Date"]);
      var hours = parseHours(row["Billable Hours"]);
      if (!(hours > 0)) return;
      var line = {
        date: date,
        procedureCode: (row["Procedure Code"] || "").trim(),
        modifier: (row["Modifiers"] || "").trim(),
        hours: hours,
        csvHourlyRate: parseMoney(row["Billable Rate"]),
        amount: parseMoney(row["Billable Amount"]),
      };
      if (!accum.has(client)) accum.set(client, new Map());
      var byDate = accum.get(client);
      var existing = byDate.get(date.key);
      if (existing) {
        // Same-day merge: keep the first row's code and rate, add hours/amounts.
        existing.modifier = existing.modifier || line.modifier;
        existing.hours = existing.hours + line.hours;
        existing.amount = existing.amount + line.amount;
      } else {
        byDate.set(date.key, line);
      }
    });

    var groups = new Map();
    accum.forEach(function (byDate, client) {
      byDate.forEach(function (line) {
        var key = client + "\u0000" + line.date.year + "\u0000" + line.date.month;
        if (!groups.has(key)) {
          groups.set(key, {
            client: client,
            year: line.date.year,
            month: line.date.month,
            lines: [],
          });
        }
        groups.get(key).lines.push(line);
      });
    });

    var list = Array.from(groups.values());
    list.forEach(function (g) {
      g.lines.sort(function (a, b) {
        return a.date.key - b.date.key;
      });
    });
    list.sort(function (a, b) {
      if (a.client !== b.client) return a.client < b.client ? -1 : 1;
      if (a.year !== b.year) return a.year - b.year;
      return a.month - b.month;
    });
    return list;
  }

  function lineUnits(line) {
    // Hours come in 0.25 increments; multiply to 15-min units.
    return roundHalfEven(line.hours * UNITS_PER_HOUR);
  }

  function buildFieldValues(lines, participant) {
    var values = { participant_name: participant };
    var override = clientOverride(participant);
    var unitsPerHour = override ? override.unitsPerHour : UNITS_PER_HOUR;
    var unitType = override ? override.unitTypeLabel : UNIT_TYPE_LABEL;

    var totalUnits = 0;
    var totalAmount = 0;
    lines.forEach(function (line, idx) {
      var prefix = "row" + (idx + 1) + "_";
      var units, unitRate, amount;
      if (override) {
        // Keep units fractional (e.g. 2.5 hr -> 2.5 units) so rate * units
        // reconciles with amount; only the 15-min default is whole units.
        units = line.hours * unitsPerHour;
        unitRate = override.hourlyRate / unitsPerHour;
        amount = line.hours * override.hourlyRate;
      } else {
        units = lineUnits(line);
        unitRate = line.csvHourlyRate / UNITS_PER_HOUR;
        amount = line.amount;
      }
      values[prefix + "date"] = fmtDate(line.date);
      values[prefix + "code"] = line.procedureCode;
      values[prefix + "modifier"] = line.modifier;
      values[prefix + "units"] = fmtUnits(units);
      values[prefix + "rate"] = fmtMoney(unitRate);
      values[prefix + "unittype"] = unitType;
      values[prefix + "amount"] = fmtMoney(amount);
      totalUnits += units;
      totalAmount += amount;
    });
    values.total_units = fmtUnits(totalUnits);
    values.total_amount = fmtMoney(totalAmount);
    return values;
  }

  // Everything up to (but not including) PDF creation.
  function planInvoices(csvText) {
    var plans = [];
    parseCsv(csvText).forEach(function (group) {
      var chunks = [];
      for (var i = 0; i < group.lines.length; i += LINES_PER_PAGE) {
        chunks.push(group.lines.slice(i, i + LINES_PER_PAGE));
      }
      chunks.forEach(function (chunk, idx) {
        var base = safeFilename(group.client) + "_" + group.year + "-" + pad2(group.month);
        var suffix = chunks.length > 1 ? "_pt" + (idx + 1) : "";
        plans.push({
          filename: base + suffix + ".pdf",
          participant: group.client,
          year: group.year,
          month: group.month,
          pageIndex: idx + 1,
          pageCount: chunks.length,
          fieldValues: buildFieldValues(chunk, group.client),
        });
      });
    });
    return plans;
  }

  // ---- iLIFE IRIS Vendor Claim Form ----------------------------------------
  //
  // Same grouping as the IRIS Provider Invoice (one claim per participant per
  // calendar month, same-day visits merged), but the iLIFE grid holds 14
  // service lines per page. Fields the AxisCare CSV cannot supply (Vendor ID,
  // ForwardHealth Medicaid ID, invoice number, participant DOB when the export
  // omits it) come from the options or are left blank for hand-completion.
  // Signature lines are always left blank: the form is signed on paper.
  // The per-client billing overrides above do NOT apply to this form.

  var LINES_PER_CLAIM = 14;
  var UNIT_BASIS_15MIN = "15 min";
  var UNIT_BASIS_HOUR = "HR";

  // The DOB boxes and the Modifiers column are ~20pt wide; at the template's
  // default font a 4-digit year or a two-modifier string is clipped.
  var NARROW_FIELD_PT = 7.5;

  // Billing provider block ("To be completed by provider"). These are the same
  // provider details already baked into template.pdf; every value can be
  // changed on the page before generating.
  var DEFAULT_PROVIDER = {
    name: "Synergy HomeCare of Madison",
    addressStreet: "6320 Monona Dr. Ste 215",
    addressCityStateZip: "Madison, WI 53716",
    contactPerson: "Russell Bercier",
    phone: "608-400-2941",
    providerId: "99-3982407", // *Provider ID: SSN or EIN
    vendorId: "", // **Vendor ID: iLIFE assigns this; fill in before submitting
    medicaidId: "", // ***Medicaid ID: ForwardHealth provider number, if enrolled
  };

  var MEDICAID_ID_COLUMNS = [
    "Medicaid ID", "Medicaid Id", "Medicaid Number", "Client Medicaid ID",
    "Member ID", "Member Id", "Insurance ID", "Policy Number", "Policy #",
  ];
  var DOB_COLUMNS = ["DOB", "Date of Birth", "Client DOB", "Birth Date", "Birthdate"];

  function firstColumn(row, names) {
    for (var i = 0; i < names.length; i++) {
      var value = row[names[i]];
      if (value && value.trim()) return value.trim();
    }
    return "";
  }

  function validDate(year, month, day) {
    var probe = new Date(Date.UTC(2000, month - 1, day));
    probe.setUTCFullYear(year);
    if (
      year < 1 || month < 1 || day < 1 ||
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      return null;
    }
    return { year: year, month: month, day: day };
  }

  // DOB may be written MM/DD/YYYY, MM/DD/YY, YYYY-MM-DD or MM-DD-YYYY.
  // Anything else is treated as "not provided".
  function parseOptionalDate(text) {
    var t = text.trim();
    var m;
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) return validDate(+m[3], +m[1], +m[2]);
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(t))) {
      return validDate(+m[3] <= 68 ? 2000 + +m[3] : 1900 + +m[3], +m[1], +m[2]);
    }
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) return validDate(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(t))) return validDate(+m[3], +m[1], +m[2]);
    return null;
  }

  // Participant Medicaid ID / DOB, when the CSV happens to carry such columns.
  function parseClientDetails(csvText) {
    var details = new Map();
    parseCsvDicts(csvText).forEach(function (row) {
      var client = (row["Client"] || "").trim();
      if (!client) return;
      if (!details.has(client)) details.set(client, { medicaidId: "", dob: null });
      var current = details.get(client);
      if (!current.medicaidId) current.medicaidId = firstColumn(row, MEDICAID_ID_COLUMNS);
      if (current.dob === null) {
        var rawDob = firstColumn(row, DOB_COLUMNS);
        if (rawDob) current.dob = parseOptionalDate(rawDob);
      }
    });
    return details;
  }

  // "Last, First M" or "First M Last" -> [first, middle, last]
  function splitParticipantName(name) {
    name = name.split(/\s+/).filter(Boolean).join(" ");
    if (!name) return ["", "", ""];
    var comma = name.indexOf(",");
    if (comma !== -1) {
      var rest = name.slice(comma + 1).split(" ").filter(Boolean);
      return [rest[0] || "", rest.slice(1).join(" "), name.slice(0, comma).trim()];
    }
    var parts = name.split(" ");
    if (parts.length === 1) return ["", "", parts[0]];
    return [parts[0], parts.slice(1, -1).join(" "), parts[parts.length - 1]];
  }

  function pad4(n) {
    var s = String(n);
    while (s.length < 4) s = "0" + s;
    return s;
  }

  function fmtDashDate(d) {
    return pad2(d.month) + "-" + pad2(d.day) + "-" + pad4(d.year);
  }

  function splitDate(d) {
    return d ? [pad2(d.month), pad2(d.day), pad4(d.year)] : ["", "", ""];
  }

  // Field names for service-grid row `index` (1-based). The template names
  // row 1 without a suffix and rows 2-14 with _2 ... _14; the Modifiers column
  // is a separate, unlabeled Text-19 ... Text-32 series.
  function claimRowFields(index) {
    var suffix = index === 1 ? "" : "_" + index;
    return {
      code: "Service CodeRow" + index,
      modifier: "Text-" + (18 + index),
      fromDate: "Service From Date MMDDYYYY" + suffix,
      toDate: "Service To Date MMDDYYYY" + suffix,
      description: "Description" + suffix,
      unitType: "Unit Type each mile HR" + suffix,
      rate: "Rate" + suffix,
      units: "Units" + suffix,
      amount: "Billed Amount" + suffix,
    };
  }

  function narrowFieldFontSizes() {
    var sizes = { Text15: NARROW_FIELD_PT, Text17: NARROW_FIELD_PT, Text18: NARROW_FIELD_PT };
    for (var i = 1; i <= LINES_PER_CLAIM; i++) sizes[claimRowFields(i).modifier] = NARROW_FIELD_PT;
    return sizes;
  }

  function claimOptions(options) {
    options = options || {};
    var provider = {};
    Object.keys(DEFAULT_PROVIDER).forEach(function (key) {
      var given = options.provider && options.provider[key];
      provider[key] = given === undefined || given === null ? DEFAULT_PROVIDER[key] : given;
    });
    return {
      serviceDescription:
        options.serviceDescription === undefined ? "Supportive Home Care" : options.serviceDescription,
      unitBasis: options.unitBasis || UNIT_BASIS_15MIN,
      invoiceNumber: options.invoiceNumber || "",
      invoiceDate: options.invoiceDate || null, // {year, month, day}
      provider: provider,
    };
  }

  function buildClaimFieldValues(lines, participant, options, medicaidId, dob) {
    var provider = options.provider;
    var name = splitParticipantName(participant);
    var dobParts = splitDate(dob);
    var start = splitDate(lines[0].date); // lines are in date order
    var end = splitDate(lines[lines.length - 1].date);

    var values = {
      "Invoice Number": options.invoiceNumber,
      "Invoice Date": options.invoiceDate ? fmtDashDate(options.invoiceDate) : "",
      // Participant block
      PPT_Medicaid_ID: medicaidId || "",
      Text15: dobParts[0],
      Text17: dobParts[1],
      Text18: dobParts[2],
      PPT_First_Name: name[0],
      Middle: name[1],
      PPT_Last_Name: name[2],
      // Billing dates (three boxes each: MM / DD / YYYY)
      "Billing Start Date": start[0],
      undefined: start[1],
      undefined_2: start[2],
      "Billing End Date": end[0],
      undefined_3: end[1],
      undefined_4: end[2],
      // Provider block
      "Provider Name 1": provider.name,
      "Provider Name 2": "",
      "Provider Address Street 1": provider.addressStreet,
      "Provider Address Street 2": "",
      "Provider Address City State ZIP 1": provider.addressCityStateZip,
      "Provider Address City State ZIP 2": "",
      "Provider Contact Person": provider.contactPerson,
      Phone: provider.phone,
      "Provider ID": provider.providerId,
      "Vendor ID": provider.vendorId,
      "Medicaid ID": provider.medicaidId,
    };

    var hourly = options.unitBasis === UNIT_BASIS_HOUR;
    var totalAmount = 0;
    lines.forEach(function (line, idx) {
      var names = claimRowFields(idx + 1);
      values[names.code] = line.procedureCode;
      values[names.modifier] = line.modifier;
      // One row per service date, so From and To are the same day.
      values[names.fromDate] = fmtDashDate(line.date);
      values[names.toDate] = fmtDashDate(line.date);
      values[names.description] = options.serviceDescription;
      values[names.unitType] = options.unitBasis;
      values[names.rate] = fmtMoney(hourly ? line.csvHourlyRate : line.csvHourlyRate / UNITS_PER_HOUR);
      values[names.units] = fmtUnits(hourly ? line.hours : lineUnits(line));
      values[names.amount] = fmtMoney(line.amount);
      totalAmount += line.amount;
    });
    values["Billed AmountTotal"] = fmtMoney(totalAmount);
    return values;
  }

  function planClaims(csvText, rawOptions) {
    var options = claimOptions(rawOptions);
    var details = parseClientDetails(csvText);
    var plans = [];
    parseCsv(csvText).forEach(function (group) {
      var detail = details.get(group.client);
      var chunks = [];
      for (var i = 0; i < group.lines.length; i += LINES_PER_CLAIM) {
        chunks.push(group.lines.slice(i, i + LINES_PER_CLAIM));
      }
      chunks.forEach(function (chunk, idx) {
        var base = "ilife_" + safeFilename(group.client) + "_" + pad4(group.year) + "-" + pad2(group.month);
        var suffix = chunks.length > 1 ? "_pt" + (idx + 1) : "";
        plans.push({
          filename: base + suffix + ".pdf",
          participant: group.client,
          year: group.year,
          month: group.month,
          pageIndex: idx + 1,
          pageCount: chunks.length,
          fieldValues: buildClaimFieldValues(
            chunk, group.client, options, detail ? detail.medicaidId : "", detail ? detail.dob : null
          ),
        });
      });
    });
    return plans;
  }

  // ---- PDF -----------------------------------------------------------------

  // fontSizes (optional): {fieldName: pointSize} for boxes too narrow for the
  // template's own text size.
  async function fillPdf(PDFLib, templateBytes, fieldValues, fontSizes) {
    var doc = await PDFLib.PDFDocument.load(templateBytes);
    var form = doc.getForm();
    var font = doc.embedStandardFont(PDFLib.StandardFonts.Helvetica);

    // The template stores each field's text style ("/Helv 10 Tf 0 g") with an
    // escaped slash, which pdf-lib cannot read and would replace with
    // auto-sized text. Rewrite it plainly so the template's 10pt size is kept.
    var DA = PDFLib.PDFName.of("DA");
    function normalizeStyle(dict) {
      var da = dict.lookup(DA);
      if (da instanceof PDFLib.PDFString || da instanceof PDFLib.PDFHexString) {
        dict.set(DA, PDFLib.PDFString.of(da.decodeText()));
      }
    }
    normalizeStyle(form.acroForm.dict);
    form.getFields().forEach(function (f) {
      normalizeStyle(f.acroField.dict);
      var widgets = f.acroField.getWidgets();
      widgets.forEach(function (w) {
        normalizeStyle(w.dict);
      });
      var name = f.getName();
      if (fontSizes && Object.prototype.hasOwnProperty.call(fontSizes, name)) {
        var style = PDFLib.PDFString.of("/Helv " + fontSizes[name] + " Tf 0 g");
        f.acroField.dict.set(DA, style);
        widgets.forEach(function (w) {
          if (w.dict.has(DA)) w.dict.set(DA, style);
        });
      }
    });

    var drawable = true;
    Object.keys(fieldValues).forEach(function (name) {
      var value = fieldValues[name];
      var field;
      try {
        field = form.getTextField(name);
      } catch (e) {
        return; // field not on this template
      }
      field.setText(value);
      try {
        font.encodeText(value);
      } catch (e) {
        drawable = false; // a character the built-in PDF font cannot draw
      }
    });

    // Ask PDF viewers to (re)draw field contents, as the original tool did.
    form.acroForm.dict.set(PDFLib.PDFName.of("NeedAppearances"), PDFLib.PDFBool.True);

    // Normally we also draw the text into the PDF ourselves so it shows in
    // every viewer and when printed. If a value contains a character the
    // built-in font cannot draw, leave drawing to the viewer instead of failing.
    if (drawable) form.updateFieldAppearances(font);
    return doc.save({ updateFieldAppearances: false });
  }

  async function generateInvoices(PDFLib, csvText, templateBytes) {
    var plans = planInvoices(csvText);
    var out = [];
    for (var i = 0; i < plans.length; i++) {
      var plan = plans[i];
      plan.pdfBytes = await fillPdf(PDFLib, templateBytes, plan.fieldValues);
      out.push(plan);
    }
    return out;
  }

  async function generateClaims(PDFLib, csvText, templateBytes, options) {
    var plans = planClaims(csvText, options);
    var sizes = narrowFieldFontSizes();
    for (var i = 0; i < plans.length; i++) {
      plans[i].pdfBytes = await fillPdf(PDFLib, templateBytes, plans[i].fieldValues, sizes);
    }
    return plans;
  }

  // ---- ZIP (no compression; the PDFs are already compressed) ---------------

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // files: [{name, bytes: Uint8Array}] -> Uint8Array of a .zip
  function makeZip(files, when) {
    var now = when || new Date();
    var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var dosDate =
      ((Math.max(now.getFullYear(), 1980) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    var encoder = new TextEncoder();
    var chunks = [];
    var central = [];
    var offset = 0;

    files.forEach(function (file) {
      var name = encoder.encode(file.name);
      var crc = crc32(file.bytes);
      var size = file.bytes.length;

      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true); // version needed
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 0, true); // stored
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), name, file.bytes);

      var cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true);
      cd.setUint32(24, size, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);

      offset += 30 + name.length + size;
    });

    var centralSize = central.reduce(function (sum, part) {
      return sum + part.length;
    }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    var all = chunks.concat(central, [new Uint8Array(end.buffer)]);
    var total = all.reduce(function (sum, part) {
      return sum + part.length;
    }, 0);
    var out = new Uint8Array(total);
    var pos = 0;
    all.forEach(function (part) {
      out.set(part, pos);
      pos += part.length;
    });
    return out;
  }

  // ---- Reading the uploaded file -------------------------------------------

  // UTF-8 (with or without a byte-order mark), falling back to Latin-1.
  function decodeCsvBytes(bytes) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) {
      var s = "";
      for (var i = 0; i < bytes.length; i += 8192) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      return s;
    }
  }

  return {
    LINES_PER_PAGE: LINES_PER_PAGE,
    CLIENT_OVERRIDES: CLIENT_OVERRIDES,
    normalizeClientName: normalizeClientName,
    parseCsvRows: parseCsvRows,
    parseCsv: parseCsv,
    planInvoices: planInvoices,
    fillPdf: fillPdf,
    generateInvoices: generateInvoices,
    LINES_PER_CLAIM: LINES_PER_CLAIM,
    UNIT_BASIS_15MIN: UNIT_BASIS_15MIN,
    UNIT_BASIS_HOUR: UNIT_BASIS_HOUR,
    DEFAULT_PROVIDER: DEFAULT_PROVIDER,
    splitParticipantName: splitParticipantName,
    planClaims: planClaims,
    generateClaims: generateClaims,
    makeZip: makeZip,
    decodeCsvBytes: decodeCsvBytes,
    fmtMoney: fmtMoney,
    fmtUnits: fmtUnits,
    roundHalfEven: roundHalfEven,
  };
});
