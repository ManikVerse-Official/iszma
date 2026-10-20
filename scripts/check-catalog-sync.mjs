// Validates the catalog's remote -> local merge rules.
//
// Regression guard for "the admin dashboard price change reverts on reload":
// a remote row must never undo a local admin edit that is newer than the row,
// while a genuinely newer server value (another device) must still win.
//
// Run: node scripts/check-catalog-sync.mjs
import { createServer } from 'vite';

// `catalog.ts` imports `./supabase`, which builds a real client (and needs a
// WebSocket implementation on Node 20). The merge rules are pure, so stub it.
const stubSupabase = {
  name: 'stub-supabase',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './supabase' && importer && /services[\\/]catalog\.ts$/.test(importer)) {
      return '\0supabase-stub';
    }
    return null;
  },
  load(id) {
    if (id === '\0supabase-stub') {
      return 'export const isSupabaseConfigured = () => false;\nexport const supabase = {};\n';
    }
    return null;
  },
};

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
  plugins: [stubSupabase],
});

const problems = [];
let checked = 0;
const check = (label, actual, expected) => {
  checked += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) problems.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -> ${JSON.stringify(actual)}`}`);
};

try {
  const { createInitialCatalogState, mergeRemoteCatalog, localEditWins, deriveUsdPrice, applyThemePatches } =
    await server.ssrLoadModule('/src/services/catalog.ts');
  const { FREE_THEME_ID } = await server.ssrLoadModule('/src/data/greetingThemes.ts');

  const base = () => ({ ...createInitialCatalogState(), priceEditedAt: {}, productEditedAt: {} });
  const patch = (overrides) => ({ ...base(), ...overrides });

  /* ---------------- themes ---------------- */

  const editedAt = 1_700_000_500_000;
  const staleRow = { price: 47, price_usd: 2, updatedAt: editedAt - 60_000 };
  const withLocalEdit = patch({
    themePatches: { 'birthday-bash': { price: 99, price_usd: 5 } },
    priceEditedAt: { 'birthday-bash': editedAt },
  });

  const merged = mergeRemoteCatalog(withLocalEdit, {
    products: null,
    themePrices: { 'birthday-bash': staleRow },
    themeCatalog: null,
  });
  check('stale server row cannot revert a newer local price', merged.themePatches['birthday-bash'].price, 99);
  check('stale server row cannot revert a newer local USD price', merged.themePatches['birthday-bash'].price_usd, 5);

  const noTimestamp = mergeRemoteCatalog(withLocalEdit, {
    products: null,
    themePrices: { 'birthday-bash': { price: 47, price_usd: 2 } },
    themeCatalog: null,
  });
  check('server row with no timestamp cannot revert a local edit', noTimestamp.themePatches['birthday-bash'].price, 99);

  const newerRemote = mergeRemoteCatalog(withLocalEdit, {
    products: null,
    themePrices: { 'birthday-bash': { price: 120, price_usd: 7, updatedAt: editedAt + 60_000 } },
    themeCatalog: null,
  });
  check('a newer server row (edited elsewhere) still wins', newerRemote.themePatches['birthday-bash'].price, 120);

  const neverEdited = patch({});
  const adopted = mergeRemoteCatalog(neverEdited, {
    products: null,
    themePrices: { 'birthday-bash': staleRow },
    themeCatalog: null,
  });
  check('an untouched theme takes the server price', adopted.themePatches['birthday-bash'].price, 47);

  check('localEditWins: no local edit', localEditWins(undefined, editedAt), false);
  check('localEditWins: newer local edit', localEditWins(editedAt, editedAt - 1), true);
  check('localEditWins: newer server row', localEditWins(editedAt, editedAt + 1), false);
  check('localEditWins: unknown server time', localEditWins(editedAt, undefined), true);

  /* ---------------- free card stays free ---------------- */

  const builtIn = applyThemePatches(createInitialCatalogState());
  const free = builtIn.find((theme) => theme.id === FREE_THEME_ID);
  const priced = applyThemePatches(patch({ themePatches: { [FREE_THEME_ID]: { price: 0, price_usd: 0 } } })).find(
    (theme) => theme.id === FREE_THEME_ID,
  );
  check('the free welcome card leads the storefront', builtIn[0]?.id, FREE_THEME_ID);
  check('a free theme stays ₹0', free?.price, 0);
  check('a free theme never becomes $1', free?.price_usd, 0);
  check('a patched free theme is still ₹0', priced?.price, 0);
  check('a patched free theme never becomes $1', priced?.price_usd, 0);
  check('deriveUsdPrice(0, 0) is 0', deriveUsdPrice(0, 0), 0);
  check('deriveUsdPrice(0, undefined) is 0', deriveUsdPrice(0), 0);

  /* ---------------- products ---------------- */

  const remoteProduct = (id, createdAt, price) => ({
    id,
    category_id: '1',
    name: `Server ${id}`,
    description: '',
    price,
    price_inr: price,
    price_usd: 1,
    currency: 'INR',
    product_file_url: '',
    download_url: '',
    image_url: '',
    created_at: createdAt,
    updated_at: createdAt,
  });

  const editedProduct = remoteProduct('p1', '2024-01-01T00:00:00.000Z', 50);
  const localEdit = {
    ...editedProduct,
    name: 'Edited locally',
    price: 250,
    price_inr: 250,
  };
  const productState = patch({
    products: [localEdit, remoteProduct('default-1', '2023-01-01T00:00:00.000Z', 10)],
    productEditedAt: { p1: Date.parse('2025-06-01T00:00:00.000Z') },
  });

  const mergedProducts = mergeRemoteCatalog(productState, {
    products: [remoteProduct('p1', '2024-01-01T00:00:00.000Z', 50), remoteProduct('p2', '2024-05-01T00:00:00.000Z', 80)],
    themePrices: null,
    themeCatalog: null,
  });
  const p1 = mergedProducts.products.find((product) => product.id === 'p1');
  const p2 = mergedProducts.products.find((product) => product.id === 'p2');
  check('a locally edited product price survives the reload', p1?.price, 250);
  check('an untouched server product is adopted', p2?.price, 80);
  check('untouched built-in defaults are not resurrected', mergedProducts.products.length, 2);

  const locallyAdded = mergeRemoteCatalog(
    patch({ products: [remoteProduct('mine', '2025-01-01T00:00:00.000Z', 30)], productEditedAt: { mine: Date.now() } }),
    { products: [remoteProduct('p2', '2024-05-01T00:00:00.000Z', 80)], themePrices: null, themeCatalog: null },
  );
  check(
    'a product added here but not on the server is kept',
    locallyAdded.products.some((product) => product.id === 'mine'),
    true,
  );

  /* ---------------- purity ---------------- */

  const before = JSON.stringify(withLocalEdit);
  mergeRemoteCatalog(withLocalEdit, {
    products: [remoteProduct('p1', '2024-01-01T00:00:00.000Z', 50)],
    themePrices: { 'birthday-bash': { price: 1, price_usd: 1, updatedAt: editedAt + 1 } },
    themeCatalog: null,
  });
  check('mergeRemoteCatalog does not mutate its input', JSON.stringify(withLocalEdit) === before, true);

  console.log(`\ncatalog sync rules checked: ${checked}`);
  if (problems.length) {
    console.error('\n✗ Catalog sync FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\n✓ Catalog sync OK — admin price edits survive a reload.');
} finally {
  await server.close();
}
