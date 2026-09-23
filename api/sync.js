import chromium from "@sparticuz/chromium";
import { chromium as playwright } from "playwright-core";
import { createClient } from "@supabase/supabase-js";

const MAX_SHIFT_HOURS = Number(
  process.env.MAX_SHIFT_HOURS || 16
);

const SHIFT_REBUILD_HOURS = Number(
  process.env.SHIFT_REBUILD_HOURS || 72
);

/*
  IPS gives us local Lithuanian timestamps like:

  2026-09-22 22:57:00

  We store them in Supabase as timestamp without time zone.

  For calculations we temporarily treat those components as UTC.
  This keeps hour differences simple without shifting the displayed time.
*/

function normalizeIpsDateTime(value) {
  if (!value) return null;

  return value
    .trim()
    .replace(" ", "T")
    .slice(0, 19);
}

function pseudoTimestampMs(value) {
  if (!value) return null;

  const normalized = normalizeIpsDateTime(value);

  return Date.parse(`${normalized}Z`);
}

function formatPseudoTimestamp(ms) {
  return new Date(ms)
    .toISOString()
    .slice(0, 19);
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

function chunkArray(array, size) {
  const chunks = [];

  for (
    let i = 0;
    i < array.length;
    i += size
  ) {
    chunks.push(
      array.slice(i, i + size)
    );
  }

  return chunks;
}

/*
  Build shifts for each employee.

  Rule:

  First measurement starts a shift.

  Any later measurement for that employee that happens
  within MAX_SHIFT_HOURS from the FIRST measurement
  belongs to the same shift.

  Example:

  2026-09-22 21:55
  2026-09-23 01:10
  2026-09-23 06:03

  becomes:

  21:55 -> 06:03

  This supports overnight shifts.
*/

function buildShifts(measurements) {
  const employees = new Map();

  for (const row of measurements) {
    if (
      !row.employee_number ||
      !row.measured_at
    ) {
      continue;
    }

    const key = String(
      row.employee_number
    );

    if (!employees.has(key)) {
      employees.set(key, []);
    }

    employees.get(key).push(row);
  }

  const shifts = [];

  for (
    const [, employeeMeasurements]
    of employees
  ) {
    employeeMeasurements.sort(
      (a, b) =>
        pseudoTimestampMs(
          a.measured_at
        ) -
        pseudoTimestampMs(
          b.measured_at
        )
    );

    let currentShift = null;

    for (
      const measurement
      of employeeMeasurements
    ) {
      const measurementMs =
        pseudoTimestampMs(
          measurement.measured_at
        );

      if (
        measurementMs === null
      ) {
        continue;
      }

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

          start_measurement_id:
            measurement.measurement_id,

          end_measurement_id: null,

          test_count: 1,

          status: "single_test",

          updated_at:
            new Date().toISOString(),
        };

        continue;
      }

      const startMs =
        pseudoTimestampMs(
          currentShift.shift_start
        );

      const hoursFromStart =
        (
          measurementMs -
          startMs
        ) /
        1000 /
        60 /
        60;

      /*
        Same shift.
      */

      if (
        hoursFromStart >= 0 &&
        hoursFromStart <=
          MAX_SHIFT_HOURS
      ) {
        currentShift.shift_end =
          measurement.measured_at;

        currentShift.end_measurement_id =
          measurement.measurement_id;

        currentShift.test_count += 1;

        currentShift.worked_minutes =
          Math.round(
            (
              measurementMs -
              startMs
            ) /
              1000 /
              60
          );

        currentShift.status =
          "paired";

        currentShift.employee_name =
          measurement.employee_name ||
          currentShift.employee_name;

        currentShift.employee_surname =
          measurement.employee_surname ||
          currentShift.employee_surname;

        continue;
      }

      /*
        Measurement is outside current shift window.

        Save current shift and start another.
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

        start_measurement_id:
          measurement.measurement_id,

        end_measurement_id: null,

        test_count: 1,

        status: "single_test",

        updated_at:
          new Date().toISOString(),
      };
    }

    if (currentShift) {
      shifts.push(currentShift);
    }
  }

  shifts.sort(
    (a, b) =>
      pseudoTimestampMs(
        a.shift_start
      ) -
      pseudoTimestampMs(
        b.shift_start
      )
  );

  return shifts;
}

async function getRecentMeasurements(
  supabase,
  since
) {
  const allRows = [];

  const pageSize = 1000;

  let from = 0;

  while (true) {
    const to =
      from + pageSize - 1;

    const {
      data,
      error,
    } =
      await supabase
        .from(
          "ips_measurements"
        )
        .select(
          `
          measurement_id,
          employee_number,
          employee_name,
          employee_surname,
          measured_at
          `
        )
        .gte(
          "measured_at",
          since
        )
        .order(
          "measured_at",
          {
            ascending: true,
          }
        )
        .range(
          from,
          to
        );

    if (error) {
      throw new Error(
        `Could not load recent measurements: ${error.message}`
      );
    }

    if (
      !data ||
      data.length === 0
    ) {
      break;
    }

    allRows.push(...data);

    if (
      data.length <
      pageSize
    ) {
      break;
    }

    from += pageSize;

    /*
      Safety limit.
      We should never realistically need
      anywhere near this many for 72 hours.
    */

    if (from >= 10000) {
      break;
    }
  }

  return allRows;
}

export default async function handler(
  req,
  res
) {
  let browser;

  try {
    /*
      ENV
    */

    const required = [
      "IPS_EMAIL",
      "IPS_PASSWORD",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
    ];

    const missing =
      required.filter(
        (key) =>
          !process.env[key]
      );

    if (missing.length) {
      return res
        .status(500)
        .json({
          ok: false,
          stage: "env",
          error:
            `Missing environment variables: ${missing.join(
              ", "
            )}`,
        });
    }

    console.log(
      "Starting IPS breath-test sync"
    );

    /*
      SUPABASE
    */

    const supabase =
      createClient(
        process.env
          .SUPABASE_URL,

        process.env
          .SUPABASE_SERVICE_ROLE_KEY,

        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
        }
      );

    /*
      CHROMIUM
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

    await emailInput.fill(
      process.env.IPS_EMAIL
    );

    await passwordInput.fill(
      process.env.IPS_PASSWORD
    );

    console.log(
      "Submitting login"
    );

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

    await submitButton.click();

    const loginResponse =
      await loginResponsePromise;

    console.log(
      "Login API status:",
      loginResponse.status()
    );

    if (
      !loginResponse.ok()
    ) {
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
      WAIT FOR PORTAL
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
      EVENTS PAGE
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
      ACCESS TOKEN
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
      await page.evaluate(
        () => {
          const local = {};
          const session = {};

          for (
            let i = 0;
            i <
            localStorage.length;
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
            i <
            sessionStorage.length;
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
        }
      );

    const accessToken =
      accessTokenCookie?.value ||
      storage.local
        .accessToken ||
      storage.local.token ||
      storage.session
        .accessToken ||
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
      FETCH LATEST 500
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

    const measurements =
      await response.json();

    console.log(
      `Received ${measurements.length} measurements`
    );

    /*
      NORMALIZE
    */

    const rows =
      measurements
        .filter(
          (item) =>
            item.measurement
              ?.id &&
            item.measurement
              ?.dateTime &&
            item.employee
              ?.employeeNumber
        )
        .map(
          (item) => ({
            measurement_id:
              item.measurement.id,

            employee_number:
              item.employee
                .employeeNumber,

            employee_name:
              item.employee
                ?.name
                ?.trim() ||
              null,

            employee_surname:
              item.employee
                ?.surname
                ?.trim() ||
              null,

            measured_at:
              normalizeIpsDateTime(
                item.measurement
                  .dateTime
              ),

            result_text:
              item.measurement
                ?.result ||
              null,

            result_promille:
              parsePromille(
                item.measurement
                  ?.result
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
              item.isViolation ??
              false,

            is_access_control_event:
              item
                .isAccessControlEvent ??
              false,

            latitude:
              item.measurement
                ?.latitude ??
              null,

            longitude:
              item.measurement
                ?.longitude ??
              null,

            measurement_photo:
              item.measurement
                ?.measurementPhoto ||
              null,

            synced_at:
              new Date().toISOString(),
          })
        );

    console.log(
      `Normalized ${rows.length} measurements`
    );

    /*
      SAVE RAW MEASUREMENTS

      We upsert by measurement_id.

      Therefore the same measurement
      can be downloaded every 10 minutes
      without creating duplicates.
    */

    const rawChunks =
      chunkArray(
        rows,
        250
      );

    for (
      const chunk
      of rawChunks
    ) {
      const {
        error,
      } =
        await supabase
          .from(
            "ips_measurements"
          )
          .upsert(
            chunk,
            {
              onConflict:
                "measurement_id",
            }
          );

      if (error) {
        throw new Error(
          `Supabase raw measurement upsert failed: ${error.message}`
        );
      }
    }

    console.log(
      `${rows.length} raw measurements saved`
    );

    /*
      FIND NEWEST IPS TIME
    */

    let newestMs = null;

    for (const row of rows) {
      const ms =
        pseudoTimestampMs(
          row.measured_at
        );

      if (
        ms !== null &&
        (
          newestMs === null ||
          ms > newestMs
        )
      ) {
        newestMs = ms;
      }
    }

    if (
      newestMs === null
    ) {
      return res
        .status(200)
        .json({
          ok: true,

          fetched:
            measurements.length,

          saved:
            rows.length,

          shiftsBuilt: 0,

          message:
            "No usable timestamps found",
        });
    }

    /*
      REBUILD RECENT SHIFTS

      Default = last 72 hours.

      That's comfortably larger
      than our default 16-hour
      maximum shift.
    */

    const rebuildSinceMs =
      newestMs -
      SHIFT_REBUILD_HOURS *
        60 *
        60 *
        1000;

    const rebuildSince =
      formatPseudoTimestamp(
        rebuildSinceMs
      );

    console.log(
      "Rebuilding shifts since:",
      rebuildSince
    );

    /*
      Load raw data from Supabase,
      not just this one IPS request.

      This is important because an
      overnight shift may have started
      during a previous sync.
    */

    const recentMeasurements =
      await getRecentMeasurements(
        supabase,
        rebuildSince
      );

    console.log(
      `Loaded ${recentMeasurements.length} recent raw measurements`
    );

    const shifts =
      buildShifts(
        recentMeasurements
      );

    console.log(
      `Built ${shifts.length} shifts`
    );

    /*
      Delete calculated shifts from
      the recent rebuild window.

      Raw measurements are NEVER deleted.

      Then we recreate the derived shifts
      from the source data.
    */

    const {
      error:
        deleteShiftError,
    } =
      await supabase
        .from(
          "ips_work_shifts"
        )
        .delete()
        .gte(
          "shift_start",
          rebuildSince
        );

    if (
      deleteShiftError
    ) {
      throw new Error(
        `Could not clear recent shifts: ${deleteShiftError.message}`
      );
    }

    /*
      INSERT REBUILT SHIFTS
    */

    const shiftChunks =
      chunkArray(
        shifts,
        250
      );

    for (
      const chunk
      of shiftChunks
    ) {
      if (
        chunk.length === 0
      ) {
        continue;
      }

      const {
        error,
      } =
        await supabase
          .from(
            "ips_work_shifts"
          )
          .insert(chunk);

      if (error) {
        throw new Error(
          `Shift insert failed: ${error.message}`
        );
      }
    }

    /*
      CURRENT / RECENT SHIFT PREVIEW
    */

    const recentShiftPreview =
      [...shifts]
        .sort(
          (a, b) =>
            pseudoTimestampMs(
              b.shift_start
            ) -
            pseudoTimestampMs(
              a.shift_start
            )
        )
        .slice(0, 20)
        .map(
          (shift) => ({
            employeeNumber:
              shift.employee_number,

            employee:
              [
                shift.employee_name,
                shift.employee_surname,
              ]
                .filter(Boolean)
                .join(" "),

            shiftDate:
              shift.shift_date,

            start:
              shift.shift_start,

            end:
              shift.shift_end,

            workedMinutes:
              shift.worked_minutes,

            workedHours:
              shift.worked_minutes !==
              null
                ? Number(
                    (
                      shift.worked_minutes /
                      60
                    ).toFixed(
                      2
                    )
                  )
                : null,

            testCount:
              shift.test_count,

            status:
              shift.status,
          })
        );

    console.log(
      "IPS sync complete"
    );

    return res
      .status(200)
      .json({
        ok: true,

        ipsFetched:
          measurements.length,

        rawSaved:
          rows.length,

        shiftRebuildHours:
          SHIFT_REBUILD_HOURS,

        maxShiftHours:
          MAX_SHIFT_HOURS,

        recentMeasurementsUsed:
          recentMeasurements.length,

        shiftsBuilt:
          shifts.length,

        accessTokenFound:
          Boolean(
            accessToken
          ),

        refreshTokenFound:
          Boolean(
            refreshTokenCookie
              ?.value
          ),

        recentShifts:
          recentShiftPreview,
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
