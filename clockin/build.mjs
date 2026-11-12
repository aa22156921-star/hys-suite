import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
let t = readFileSync('src/worker.template.js', 'utf8')
  .replace('__EMPLOYEE_HTML__', () => JSON.stringify(readFileSync('src/employee.html', 'utf8')))
  .replace('__ADMIN_HTML__', () => JSON.stringify(readFileSync('src/admin.html', 'utf8')))
  .replace('__ANDROID_HTML__', () => JSON.stringify(readFileSync('src/android.html', 'utf8')));
const icons = {}; for (const f of ['icon-180.png','icon-192.png','icon-512.png','fav-64.png']) icons['/' + f] = readFileSync('src/icons/' + f).toString('base64');
t = t.replace('__ICONS__', () => JSON.stringify(icons));
mkdirSync('dist', { recursive: true }); writeFileSync('dist/_worker.js', t); console.log('ok', t.length);
