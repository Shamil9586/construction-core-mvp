import { defineConfig } from '@playwright/test';

/** S3 browser UI proof with intercepted API; does not replace native backend acceptance. */
export default defineConfig({
  testDir:'./tests/gpr2-r05-finish-systems-browser',workers:1,retries:0,timeout:60000,
  expect:{timeout:10000},reporter:[['list']],
  use:{baseURL:'http://127.0.0.1:5173',viewport:{width:1440,height:1000},locale:'ru-RU',timezoneId:'UTC',screenshot:'only-on-failure'},
  webServer:{command:'npm run dev:web',url:'http://127.0.0.1:5173/app.html',reuseExistingServer:false,timeout:120000,env:{VITE_DATA_PROVIDER:'real'}},
});
