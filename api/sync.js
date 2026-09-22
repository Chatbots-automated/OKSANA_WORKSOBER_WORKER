import chromium from "@sparticuz/chromium";
import { chromium as playwright } from "playwright-core";

export default async function handler(req, res) {
  let browser;

  try {
    if (!process.env.IPS_EMAIL || !process.env.IPS_PASSWORD) {
      return res.status(500).json({
        ok: false,
        error: "Missing IPS_EMAIL or IPS_PASSWORD environment variable",
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

    console.log("Opening login page");

    await page.goto("https://login.ips.lt/lt", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Correct selectors based on the actual IPS login HTML
    const emailInput = page
      .locator('input[autocomplete="email"]')
      .first();

    const passwordInput = page
      .locator('input[autocomplete="current-password"]')
      .first();

    const submitButton = page
      .locator('button[type="submit"]')
      .first();

    await emailInput.waitFor({
      state: "visible",
      timeout: 15000,
    });

    await passwordInput.waitFor({
      state: "visible",
      timeout: 15000,
    });

    console.log("Filling login credentials");

    await emailInput.fill(process.env.IPS_EMAIL);
    await passwordInput.fill(process.env.IPS_PASSWORD);

    console.log("Submitting login");

    await submitButton.click();

    // Wait for login flow to complete
    try {
      await page.waitForURL(
        (url) =>
          url.hostname.includes("portal.ips.lt") ||
          url.hostname.includes("login.ips.lt"),
        {
          timeout: 30000,
        }
      );
    } catch {
      console.log("URL wait timed out, continuing...");
    }

    console.log("URL after login:", page.url());

    // Open the actual IPS measurements page
    console.log("Opening IPS events page");

    await page.goto(
      "https://portal.ips.lt/lt/events/general",
      {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }
    );

    console.log("Events page URL:", page.url());

    // Get cookies
    const cookies = await context.cookies();

    const accessTokenCookie = cookies.find(
      (cookie) => cookie.name === "accessToken"
    );

    const refreshTokenCookie = cookies.find(
      (cookie) => cookie.name === "refreshToken"
    );

    console.log(
      "Access token cookie:",
      accessTokenCookie ? "FOUND" : "NOT FOUND"
    );

    console.log(
      "Refresh token cookie:",
      refreshTokenCookie ? "FOUND" : "NOT FOUND"
    );

    // Also inspect localStorage in case IPS stores auth there
    let browserStorage = {};

    try {
      browserStorage = await page.evaluate(() => {
        const data = {};

        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);

          if (key) {
            data[key] = localStorage.getItem(key);
          }
        }

        return data;
      });
    } catch (error) {
      console.log("Could not inspect localStorage:", error.message);
    }

    const accessToken =
      accessTokenCookie?.value ||
      browserStorage.accessToken ||
      browserStorage.token ||
      null;

    console.log(
      "Final access token:",
      accessToken ? "FOUND" : "NOT FOUND"
    );

    // Fetch measurements
    const items = 500;

    const apiUrl =
      `https://portal.ips.lt/api/measurements/latest?items=${items}`;

    const headers = {
      Accept: "application/json, text/plain, */*",
      Referer: "https://portal.ips.lt/lt/events/general",
    };

    if (accessToken) {
      headers["X-Authorization"] =
        `Bearer ${accessToken}`;
    }

    console.log("Fetching measurements");

    const response = await context.request.get(
      apiUrl,
      {
        headers,
        timeout: 30000,
      }
    );

    console.log(
      "Measurements API status:",
      response.status()
    );

    if (!response.ok()) {
      const responseText = await response.text();

      return res.status(response.status()).json({
        ok: false,
        stage: "measurements",
        status: response.status(),
        accessTokenFound: Boolean(accessToken),
        refreshTokenFound: Boolean(
          refreshTokenCookie?.value
        ),
        currentUrl: page.url(),
        error: responseText,
      });
    }

    const measurements = await response.json();

    console.log(
      `Received ${measurements.length} measurements`
    );

    const preview = measurements
      .slice(0, 10)
      .map((item) => ({
        measurementId:
          item.measurement?.id ?? null,

        dateTime:
          item.measurement?.dateTime ?? null,

        result:
          item.measurement?.result ?? null,

        employeeNumber:
          item.employee?.employeeNumber ?? null,

        name:
          item.employee?.name?.trim() ?? null,

        surname:
          item.employee?.surname?.trim() ?? null,

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
      count: measurements.length,
      accessTokenFound: Boolean(accessToken),
      refreshTokenFound: Boolean(
        refreshTokenCookie?.value
      ),
      preview,
    });
  } catch (error) {
    console.error("IPS sync error");
    console.error(error);

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Unknown IPS sync error",
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore browser close errors
      }
    }
  }
}
