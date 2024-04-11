import { existsSync, writeFileSync } from 'fs'
import { getProjectDir } from '../lib/get-project-dir'
import { printAndExit } from '../server/lib/utils'
import loadConfig from '../server/config'
import { PHASE_PRODUCTION_BUILD } from '../api/constants'
import {
  hasNecessaryDependencies,
  type MissingDependency,
} from '../lib/has-necessary-dependencies'
import { installDependencies } from '../lib/install-dependencies'
import type { NextConfigComplete } from '../server/config-shared'
import findUp from 'next/dist/compiled/find-up'
import { warn } from '../build/output/log'
import { bold, cyan } from '../lib/picocolors'
import { findPagesDir } from '../lib/find-pages-dir'
import { verifyTypeScriptSetup } from '../lib/verify-typescript-setup'
import path from 'path'
import {
  getPkgManager,
  type PackageManager,
} from '../lib/helpers/get-pkg-manager'

export interface NextTestOptions {}

export const SUPPORTED_TEST_RUNNERS_LIST = ['playwright'] as const
export type SUPPORTED_TEST_RUNNERS =
  (typeof SUPPORTED_TEST_RUNNERS_LIST)[number]

const requiredPackagesByTestRunner: {
  [k in SUPPORTED_TEST_RUNNERS]: MissingDependency[]
} = {
  playwright: [
    { file: 'playwright', pkg: '@playwright/test', exportsRestrict: false },
  ],
}

function isSupportedTestRunner(
  testRunner: string
): testRunner is SUPPORTED_TEST_RUNNERS {
  return testRunner in requiredPackagesByTestRunner
}

export async function nextTest(
  directory?: string,
  testRunner?: string,
  options?: unknown
) {
  // get execution directory
  const baseDir = getProjectDir(directory)

  // Check if the directory exists
  if (!existsSync(baseDir)) {
    printAndExit(`> No such directory exists as the project root: ${baseDir}`)
  }

  // find nextConfig
  const nextConfig = await loadConfig(PHASE_PRODUCTION_BUILD, baseDir)

  // set the test runner. priority is CLI option > next config > default 'playwright'
  const configuredTestRunner =
    testRunner ?? nextConfig.experimental.defaultTestRunner ?? 'playwright'

  switch (configuredTestRunner) {
    case 'playwright':
      return runPlaywright(baseDir, nextConfig)
    default:
      return printAndExit(
        `Test runner ${configuredTestRunner} is not supported.`
      )
  }
}

async function checkRequiredDeps(
  baseDir: string,
  testRunner: SUPPORTED_TEST_RUNNERS
) {
  const deps = await hasNecessaryDependencies(
    baseDir,
    requiredPackagesByTestRunner[testRunner]
  )
  if (deps.missing.length > 0) {
    await installDependencies(baseDir, deps.missing, true)
  }
}

async function runPlaywright(baseDir: string, nextConfig: NextConfigComplete) {
  await checkRequiredDeps(baseDir, 'playwright')

  const playwrightConfigFile = await findUp(
    ['playwright.config.js', 'playwright.config.ts'],
    {
      cwd: baseDir,
    }
  )

  if (!playwrightConfigFile) {
    const { pagesDir, appDir } = findPagesDir(baseDir)

    const { version: typeScriptVersion } = await verifyTypeScriptSetup({
      dir: baseDir,
      distDir: nextConfig.distDir,
      intentDirs: [pagesDir, appDir].filter(Boolean) as string[],
      typeCheckPreflight: false,
      tsconfigPath: nextConfig.typescript.tsconfigPath,
      disableStaticImages: nextConfig.images.disableStaticImages,
      hasAppDir: !!appDir,
      hasPagesDir: !!pagesDir,
    })

    const isUsingTypeScript = !!typeScriptVersion

    const playwrightConfigFilename = `playwright.config.${
      isUsingTypeScript ? 'ts' : 'js'
    }`

    const packageManager = getPkgManager(baseDir)

    writeFileSync(
      path.join(baseDir, playwrightConfigFilename),
      defaultPlaywrightConfig(isUsingTypeScript, packageManager)
    )
  }
}

const defaultPlaywrightConfig = (
  typescript: boolean,
  packageManager: PackageManager
) => `
${
  typescript
    ? "import { defineConfig, devices } from 'next/experimental/testmode/playwright'"
    : "const { defineConfig, devices } = require('next/experimental/testmode/playwright')"
};

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// require('dotenv').config();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
${
  typescript
    ? 'export default definedConfig({'
    : 'module.exports = defineConfig({'
}
  /* Match all co-located test files within app and pages directories*/
  testMatch: '{app,pages}/**/*.spec.{t,j}s',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like \`await page.goto('/')\`. */
    baseURL: 'http://127.0.0.1:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    command: '${packageManager === 'npm' ? 'npm run' : packageManager} dev',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
  },
});`
