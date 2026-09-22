import chromium from "@sparticuz/chromium";
import { chromium as playwright } from "playwright-core";

export default async function handler(req, res) {
  let browser;

  try {
    if (!process.env.IPS_EMAIL || !process.env.IPS_PASSWORD) {
      return res.status(500).json({
        ok: false,
        stage: "env",
        error: "Missing IPS_EMAIL or IPS_PASSWORD",
      });
    }

    console.log("Starting IPS breath test sync");

    browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const context = await browser.newContext();

    const page = await context.newPage();

    console.log("Opening login");

    await page.goto("https://login.ips.lt/lt", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const emailInput = page.locator(
      'input[autocomplete="email"]'
    );

    const passwordInput = page.locator(
      'input[autocomplete="current-password"]'
    );

    const submitButton = page.locator(
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

    console.log("Filling credentials");

    await emailInput.fill(process.env.IPS_EMAIL);
    await passwordInput.fill(process.env.IPS_PASSWORD);

    console.log("Submitting login");

    /*
      IMPORTANT:
      Wait for the real login API request.
    */

    const loginResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/account/login") &&
        response.request().method() === "POST",
      {
        timeout: 30000,
      }
    );

    await submitButton.click();

    const loginResponse = await loginResponsePromise;

    console.log(
      "Login API status:",
      loginResponse.status()
    );

    let loginBody = null;

    try {
      loginBody = await loginResponse.json();
    } catch {
      try {
        loginBody = await loginResponse.text();
      } catch {
        loginBody = null;
      }
    }

    console.log(
      "Login response received"
    );

    /*
      If IPS itself rejected the credentials,
      stop here and show us the actual response.
    */

    if (!loginResponse.ok()) {
      return res.status(401).json({
        ok: false,
        stage: "login-api",
        status: loginResponse.status(),
        currentUrl: page.url(),
        loginResponse: loginBody,
      });
    }

    /*
      NOW wait specifically for the portal.

      Do NOT accept login.ips.lt as success.
    */

    console.log("Waiting for portal redirect");

    try {
      await page.waitForURL(
        (url) =>
          url.hostname === "portal.ips.lt",
        {
          timeout: 30000,
        }
      );
    } catch (error) {
      /*
        Give the frontend a tiny chance to finish
        any JS redirect.
      */

      await page.waitForTimeout(3000);

      console.log(
        "URL after waiting:",
        page.url()
      );

      if (!page.url().includes("portal.ips.lt")) {
        return res.status(401).json({
          ok: false,
          stage: "portal-redirect",
          error:
            "Login API returned 200 but browser did not reach portal",
          currentUrl: page.url(),
          loginResponse: loginBody,
        });
      }
    }

    console.log(
      "Portal reached:",
      page.url()
    );

    /*
      Wait for portal authentication initialization.
    */

    await page.goto(
      "https://portal.ips.lt/lt/events/general",
      {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }
    );

    console.log(
      "Events page:",
      page.url()
    );

    await page.waitForTimeout(2000);

    /*
      Read cookies.
    */

    const cookies = await context.cookies();

    const accessTokenCookie = cookies.find(
      (cookie) =>
        cookie.name === "accessToken"
    );

    const refreshTokenCookie = cookies.find(
      (cookie) =>
        cookie.name === "refreshToken"
    );

    console.log(
      "Access token cookie:",
      accessTokenCookie ? "FOUND" : "NOT FOUND"
    );

    console.log(
      "Refresh token cookie:",
      refreshTokenCookie ? "FOUND" : "NOT FOUND"
    );

    /*
      Also check localStorage/sessionStorage.
    */

    const storage = await page.evaluate(() => {
      const local = {};
      const session = {};

      for (
        let i = 0;
        i < localStorage.length;
        i++
      ) {
        const key = localStorage.key(i);

        if (key) {
          local[key] =
            localStorage.getItem(key);
        }
      }

      for (
        let i = 0;
        i < sessionStorage.length;
        i++
      ) {
        const key = sessionStorage.key(i);

        if (key) {
          session[key] =
            sessionStorage.getItem(key);
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

    console.log(
      "Final access token:",
      accessToken ? "FOUND" : "NOT FOUND"
    );

    /*
      Fetch measurements.
    */

    const apiUrl =
      "https://portal.ips.lt/api/measurements/latest?items=500";

    const headers = {
      Accept:
        "application/json, text/plain, */*",
      Referer:
        "https://portal.ips.lt/lt/events/general",
    };

    if (accessToken) {
      headers["X-Authorization"] =
        `Bearer ${accessToken}`;
    }

    console.log(
      "Fetching measurements"
    );

    const response =
      await context.request.get(
        apiUrl,
        {
          headers,
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
        .status(response.status())
        .json({
          ok: false,
          stage: "measurements",
          status:
            response.status(),

          currentUrl:
            page.url(),

          accessTokenFound:
            Boolean(accessToken),

          refreshTokenFound:
            Boolean(
              refreshTokenCookie?.value
            ),

          localStorageKeys:
            Object.keys(storage.local),

          sessionStorageKeys:
            Object.keys(storage.session),

          error: body,
        });
    }

    const measurements =
      await response.json();

    console.log(
      `Received ${measurements.length} measurements`
    );

    const preview = measurements
      .slice(0, 10)
      .map((item) => ({
        measurementId:
          item.measurement?.id ?? null,

        dateTime:
          item.measurement?.dateTime ??
          null,

        result:
          item.measurement?.result ??
          null,

        employeeNumber:
          item.employee
            ?.employeeNumber ?? null,

        name:
          item.employee?.name?.trim() ??
          null,

        surname:
          item.employee?.surname?.trim() ??
          null,

        deviceSerial:
          item.deviceSerial ?? null,

        companyObject:
          item.companyObject ?? null,

        subdivision:
          item.subdivision ?? null,

        isViolation:
          item.isViolation ?? false,
      }));

    return res.status(200).json({
      ok: true,

      count:
        measurements.length,

      accessTokenFound:
        Boolean(accessToken),

      refreshTokenFound:
        Boolean(
          refreshTokenCookie?.value
        ),

      preview,
    });
  } catch (error) {
    console.error(
      "IPS sync error:",
      error
    );

    return res.status(500).json({
      ok: false,
      stage: "exception",
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
