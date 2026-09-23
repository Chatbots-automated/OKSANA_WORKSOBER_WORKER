import chromium from "@sparticuz/chromium";
import { chromium as playwright } from "playwright-core";

/*
  Hardcoded shift rule.

  Any measurements from the same employee
  within 16 hours from the FIRST measurement
  are treated as one shift.

  This allows overnight shifts such as:

  2026-09-22 21:55
  2026-09-23 01:10
  2026-09-23 06:03

  => one shift:
     21:55 -> 06:03
*/

const MAX_SHIFT_HOURS = 16;

/*
  IPS gives local Lithuanian timestamps:

  2026-09-22 22:57:00

  Keep them as local clock timestamps.
*/

function normalizeIpsDateTime(value) {
  if (!value) return null;

  return value
    .trim()
    .replace(" ", "T")
    .slice(0, 19);
}

/*
  Used only to calculate differences between
  timestamps without changing their displayed time.
*/

function timestampMs(value) {
  if (!value) return null;

  const normalized = normalizeIpsDateTime(value);

  return Date.parse(`${normalized}Z`);
}

function parsePromille(value) {
  if (!value) return null;

  const parsed = parseFloat(
    String(value)
      .replace("‰", "")
      .replace(",", ".")
      .trim()
  );

  return Number.isNaN(parsed)
    ? null
    : parsed;
}

/*
  Convert IPS response into clean rows
  that n8n can upsert directly into Supabase.
*/

function normalizeMeasurements(measurements) {
  return measurements
    .filter(
      (item) =>
        item.measurement?.id &&
        item.measurement?.dateTime &&
        item.employee?.employeeNumber
    )
    .map((item) => ({
      measurement_id:
        item.measurement.id,

      employee_number:
        item.employee.employeeNumber,

      employee_name:
        item.employee?.name?.trim() ||
        null,

      employee_surname:
        item.employee?.surname?.trim() ||
        null,

      measured_at:
        normalizeIpsDateTime(
          item.measurement.dateTime
        ),

      result_text:
        item.measurement?.result ||
        null,

      result_promille:
        parsePromille(
          item.measurement?.result
        ),

      device_serial:
        item.deviceSerial ||
        null,

      company_object:
        item.companyObject ||
        null,

      subdivision:
        item.subdivision ||
        null,

      is_violation:
        item.isViolation ?? false,

      is_access_control_event:
        item.isAccessControlEvent ?? false,

      latitude:
        item.measurement?.latitude ??
        null,

      longitude:
        item.measurement?.longitude ??
        null,

      measurement_photo:
        item.measurement?.measurementPhoto ||
        null,
    }));
}

/*
  Build work shifts from the measurements.

  Measurements are grouped by employee.

  The FIRST measurement starts a shift.

  Every next measurement within 16 hours
  from that FIRST measurement stays in
  the same shift.

  Earliest = work start
  Latest   = work end
*/

function buildShifts(measurements) {
  const employeeGroups = new Map();

  /*
    Group by employee number.
  */

  for (const measurement of measurements) {
    if (
      !measurement.employee_number ||
      !measurement.measured_at
    ) {
      continue;
    }

    const key = String(
      measurement.employee_number
    );

    if (!employeeGroups.has(key)) {
      employeeGroups.set(key, []);
    }

    employeeGroups
      .get(key)
      .push(measurement);
  }

  const shifts = [];

  /*
    Process each employee separately.
  */

  for (
    const [, employeeMeasurements]
    of employeeGroups
  ) {
    employeeMeasurements.sort(
      (a, b) =>
        timestampMs(a.measured_at) -
        timestampMs(b.measured_at)
    );

    let currentShift = null;

    for (
      const measurement
      of employeeMeasurements
    ) {
      const measurementTime =
        timestampMs(
          measurement.measured_at
        );

      if (
        measurementTime === null
      ) {
        continue;
      }

      /*
        No current shift:
        this measurement starts one.
      */

      if (!currentShift) {
        currentShift = {
          employee_number:
            measurement.employee_number,

          employee_name:
            measurement.employee_name,

          employee_surname:
            measurement.employee_surname,

          shift_date:
            measurement.measured_at.slice(
              0,
              10
            ),

          shift_start:
            measurement.measured_at,

          shift_end: null,

          worked_minutes: null,

          worked_hours: null,

          start_measurement_id:
            measurement.measurement_id,

          end_measurement_id: null,

          test_count: 1,

          status: "single_test",
        };

        continue;
      }

      const shiftStartTime =
        timestampMs(
          currentShift.shift_start
        );

      const hoursFromStart =
        (
          measurementTime -
          shiftStartTime
        ) /
        1000 /
        60 /
        60;

      /*
        Same shift.
      */

      if (
        hoursFromStart >= 0 &&
        hoursFromStart <= MAX_SHIFT_HOURS
      ) {
        const workedMinutes =
          Math.round(
            (
              measurementTime -
              shiftStartTime
            ) /
              1000 /
              60
          );

        currentShift.shift_end =
          measurement.measured_at;

        currentShift.end_measurement_id =
          measurement.measurement_id;

        currentShift.test_count += 1;

        currentShift.worked_minutes =
          workedMinutes;

        currentShift.worked_hours =
          Number(
            (
              workedMinutes / 60
            ).toFixed(2)
          );

        currentShift.status =
          "paired";

        /*
          Keep latest known name.
        */

        currentShift.employee_name =
          measurement.employee_name ||
          currentShift.employee_name;

        currentShift.employee_surname =
          measurement.employee_surname ||
          currentShift.employee_surname;

        continue;
      }

      /*
        More than 16 hours since start.

        Previous shift is finished.

        Current measurement starts
        a new shift.
      */

      shifts.push(currentShift);

      currentShift = {
        employee_number:
          measurement.employee_number,

        employee_name:
          measurement.employee_name,

        employee_surname:
          measurement.employee_surname,

        shift_date:
          measurement.measured_at.slice(
            0,
            10
          ),

        shift_start:
          measurement.measured_at,

        shift_end: null,

        worked_minutes: null,

        worked_hours: null,

        start_measurement_id:
          measurement.measurement_id,

        end_measurement_id: null,

        test_count: 1,

        status: "single_test",
      };
    }

    /*
      Don't forget employee's final shift.
    */

    if (currentShift) {
      shifts.push(currentShift);
    }
  }

  /*
    Stable unique key for n8n / Supabase upsert.

    Example:

    6_2026-09-22T22:57:00

    If another measurement comes later,
    shift_start remains the same,
    therefore n8n updates the same row.
  */

  const finalShifts =
    shifts.map((shift) => ({
      shift_key:
        `${shift.employee_number}_${shift.shift_start}`,

      ...shift,
    }));

  /*
    Newest shifts first.
  */

  finalShifts.sort(
    (a, b) =>
      timestampMs(b.shift_start) -
      timestampMs(a.shift_start)
  );

  return finalShifts;
}

export default async function handler(
  req,
  res
) {
  let browser;

  try {
    /*
      Only IPS credentials required.
    */

    if (
      !process.env.IPS_EMAIL ||
      !process.env.IPS_PASSWORD
    ) {
      return res.status(500).json({
        ok: false,
        stage: "env",
        error:
          "Missing IPS_EMAIL or IPS_PASSWORD",
      });
    }

    console.log(
      "Starting IPS breath-test sync"
    );

    /*
      Launch Chromium.
    */

    browser =
      await playwright.launch({
        args: chromium.args,

        executablePath:
          await chromium.executablePath(),

        headless: true,
      });

    const context =
      await browser.newContext();

    const page =
      await context.newPage();

    /*
      LOGIN
    */

    console.log(
      "Opening IPS login"
    );

    await page.goto(
      "https://login.ips.lt/lt",
      {
        waitUntil:
          "domcontentloaded",

        timeout: 30000,
      }
    );

    const emailInput =
      page.locator(
        'input[autocomplete="email"]'
      );

    const passwordInput =
      page.locator(
        'input[autocomplete="current-password"]'
      );

    const submitButton =
      page.locator(
        'button[type="submit"]'
      );

    await emailInput.waitFor({
      state: "visible",
      timeout: 15000,
    });

    await passwordInput.waitFor({
      state: "visible",
      timeout: 15000,
    });

    console.log(
      "Filling credentials"
    );

    await emailInput.fill(
      process.env.IPS_EMAIL
    );

    await passwordInput.fill(
      process.env.IPS_PASSWORD
    );

    /*
      Wait specifically for the login API call.
    */

    const loginResponsePromise =
      page.waitForResponse(
        (response) =>
          response
            .url()
            .includes(
              "/api/account/login"
            ) &&
          response
            .request()
            .method() === "POST",
        {
          timeout: 30000,
        }
      );

    console.log(
      "Submitting login"
    );

    await submitButton.click();

    const loginResponse =
      await loginResponsePromise;

    console.log(
      "Login API status:",
      loginResponse.status()
    );

    if (!loginResponse.ok()) {
      let body = null;

      try {
        body =
          await loginResponse.text();
      } catch {}

      return res
        .status(401)
        .json({
          ok: false,

          stage:
            "login-api",

          status:
            loginResponse.status(),

          error: body,
        });
    }

    /*
      Wait for real portal redirect.
    */

    console.log(
      "Waiting for portal"
    );

    try {
      await page.waitForURL(
        (url) =>
          url.hostname ===
          "portal.ips.lt",
        {
          timeout: 30000,
        }
      );
    } catch {
      await page.waitForTimeout(
        3000
      );

      if (
        !page
          .url()
          .includes(
            "portal.ips.lt"
          )
      ) {
        return res
          .status(401)
          .json({
            ok: false,

            stage:
              "portal-redirect",

            currentUrl:
              page.url(),
          });
      }
    }

    console.log(
      "Portal reached:",
      page.url()
    );

    /*
      Open events page to initialise
      portal authentication.
    */

    await page.goto(
      "https://portal.ips.lt/lt/events/general",
      {
        waitUntil:
          "domcontentloaded",

        timeout: 30000,
      }
    );

    await page.waitForTimeout(
      2000
    );

    /*
      Find IPS access token.
    */

    const cookies =
      await context.cookies();

    const accessTokenCookie =
      cookies.find(
        (cookie) =>
          cookie.name ===
          "accessToken"
      );

    const refreshTokenCookie =
      cookies.find(
        (cookie) =>
          cookie.name ===
          "refreshToken"
      );

    const storage =
      await page.evaluate(() => {
        const local = {};
        const session = {};

        for (
          let i = 0;
          i < localStorage.length;
          i++
        ) {
          const key =
            localStorage.key(i);

          if (key) {
            local[key] =
              localStorage.getItem(
                key
              );
          }
        }

        for (
          let i = 0;
          i < sessionStorage.length;
          i++
        ) {
          const key =
            sessionStorage.key(i);

          if (key) {
            session[key] =
              sessionStorage.getItem(
                key
              );
          }
        }

        return {
          local,
          session,
        };
      });

    const accessToken =
      accessTokenCookie?.value ||
      storage.local.accessToken ||
      storage.local.token ||
      storage.session.accessToken ||
      storage.session.token ||
      null;

    if (!accessToken) {
      return res
        .status(401)
        .json({
          ok: false,

          stage:
            "access-token",

          error:
            "Access token not found",
        });
    }

    console.log(
      "Access token found"
    );

    /*
      Get latest 500 measurements.
    */

    const apiUrl =
      "https://portal.ips.lt/api/measurements/latest?items=500";

    console.log(
      "Fetching measurements"
    );

    const response =
      await context.request.get(
        apiUrl,
        {
          headers: {
            Accept:
              "application/json, text/plain, */*",

            Referer:
              "https://portal.ips.lt/lt/events/general",

            "X-Authorization":
              `Bearer ${accessToken}`,
          },

          timeout: 30000,
        }
      );

    console.log(
      "Measurements status:",
      response.status()
    );

    if (!response.ok()) {
      const body =
        await response.text();

      return res
        .status(
          response.status()
        )
        .json({
          ok: false,

          stage:
            "measurements",

          status:
            response.status(),

          error: body,
        });
    }

    const ipsMeasurements =
      await response.json();

    console.log(
      `Received ${ipsMeasurements.length} IPS measurements`
    );

    /*
      Normalize all 500.
    */

    const measurements =
      normalizeMeasurements(
        ipsMeasurements
      );

    console.log(
      `Normalized ${measurements.length} measurements`
    );

    /*
      Build work shifts directly
      from those measurements.
    */

    const shifts =
      buildShifts(
        measurements
      );

    console.log(
      `Built ${shifts.length} shifts`
    );

    /*
      Return EVERYTHING to n8n.

      n8n handles:
      - raw measurement upsert
      - shift upsert
      - Supabase
    */

    return res
      .status(200)
      .json({
        ok: true,

        ipsFetched:
          ipsMeasurements.length,

        measurementCount:
          measurements.length,

        shiftCount:
          shifts.length,

        maxShiftHours: 16,

        accessTokenFound:
          Boolean(
            accessToken
          ),

        refreshTokenFound:
          Boolean(
            refreshTokenCookie?.value
          ),

        measurements,

        shifts,
      });
  } catch (error) {
    console.error(
      "IPS sync error:",
      error
    );

    return res
      .status(500)
      .json({
        ok: false,

        stage:
          "exception",

        error:
          error?.message ||
          "Unknown IPS error",
      });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}
