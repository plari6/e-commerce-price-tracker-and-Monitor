// Known store layouts and platform themes. Each entry: host match + selectors tried in order.
// `price` / `list` entries may be "selector" or "selector@attribute".

export const SITE_RULES = [
  {
    name: 'amazon',
    host: /(^|\.)amazon\.[a-z.]+$/,
    price: ['#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen', '#corePrice_feature_div .a-price .a-offscreen', '#apex_desktop .a-price .a-offscreen', '#priceblock_dealprice', '#priceblock_ourprice', '#price_inside_buybox', '#tp_price_block_total_price_ww .a-offscreen'],
    list: ['#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen', '.a-price.a-text-price[data-a-strike] .a-offscreen'],
    stock: ['#availability'],
    title: ['#productTitle'],
  },
  {
    name: 'ebay',
    host: /(^|\.)ebay\.[a-z.]+$/,
    price: ['.x-price-primary .ux-textspans', '[itemprop="price"]@content'],
    list: ['.x-additional-info .ux-textspans--STRIKETHROUGH', '.x-price-was .ux-textspans'],
    stock: ['.d-quantity__availability', '.x-quantity__availability'],
    title: ['h1.x-item-title__mainTitle'],
  },
  { name: 'walmart', host: /(^|\.)walmart\.[a-z.]+$/, price: ['[itemprop="price"]', '[data-seo-id="hero-price"]'], list: ['[data-seo-id="strike-through-price"]'], stock: [], title: ['h1#main-title'] },
  { name: 'bestbuy', host: /(^|\.)bestbuy\.[a-z.]+$/, price: ['.priceView-customer-price span[aria-hidden="true"]', '[data-testid="customer-price"] span'], list: ['.pricing-price__regular-price'], stock: ['.fulfillment-add-to-cart-button button'], title: ['h1'] },
  { name: 'target', host: /(^|\.)target\.com$/, price: ['[data-test="product-price"]'], list: ['[data-test="product-regular-price"]'], stock: [], title: ['h1[data-test="product-title"]'] },
  { name: 'aliexpress', host: /(^|\.)aliexpress\.[a-z.]+$/, price: ['[class*="product-price-current"]', '.uniform-banner-box-price'], list: ['[class*="price--originalText"]'], stock: [], title: ['h1[data-pl="product-title"]'] },
  { name: 'noon', host: /(^|\.)noon\.com$/, price: ['[data-qa="div-price-now"]', '.priceNow'], list: ['[data-qa="div-price-was"]', '.priceWas'], stock: [], title: ['h1'] },
  { name: 'etsy', host: /(^|\.)etsy\.com$/, price: ['[data-buy-box-region="price"] p[class*="text-title"]', '[data-selector="price-only"] p'], list: ['[data-buy-box-region="price"] .wt-text-strikethrough'], stock: [], title: ['h1'] },
  { name: 'books.toscrape', host: /^books\.toscrape\.com$/, price: ['.product_main .price_color'], list: [], stock: ['.product_main .availability'], title: ['.product_main h1'] },
  // Platform themes (any host)
  { name: 'magento', detect: /data-price-type="finalPrice"/, price: ['.product-info-main [data-price-type="finalPrice"]@data-price-amount', '.product-info-main .price-final_price .price'], list: ['.product-info-main [data-price-type="oldPrice"]@data-price-amount'], stock: ['.product-info-main .stock'], title: ['.page-title'] },
  { name: 'woocommerce', detect: /woocommerce/i, price: ['.summary .price ins .amount', '.product .summary .price > .amount', '.summary .price .woocommerce-Price-amount'], list: ['.summary .price del .amount'], stock: ['.summary .stock'], title: ['.product_title'] },
  { name: 'bigcommerce', detect: /data-product-price-without-tax|bigcommerce/i, price: ['[data-product-price-with-tax]', '[data-product-price-without-tax]'], list: ['[data-product-rrp-with-tax]', '[data-product-non-sale-price-without-tax]'], stock: ['[data-product-stock]'], title: ['.productView-title'] },
  { name: 'prestashop', detect: /prestashop/i, price: ['.product-prices .current-price [itemprop="price"]@content', '.product-prices .current-price span'], list: ['.product-prices .regular-price'], stock: ['#product-availability'], title: ['h1'] },
  { name: 'shopify-theme', detect: /cdn\.shopify\.com|Shopify\.theme/, price: ['.product__info-container .price-item--sale', '.product__info-container .price-item--regular', '[data-product-price]', '.product-single__price'], list: ['.product__info-container .price__sale s .price-item--regular', '[data-compare-price]'], stock: ['.product-form__submit'], title: ['.product__title h1', 'h1'] },
];

export function rulesFor(hostname, html) {
  const host = hostname.replace(/^www\./, '');
  return SITE_RULES.filter((r) => (r.host ? r.host.test(host) : r.detect.test(html)));
}

export function readSelector($, spec) {
  const [sel, attr] = spec.split('@');
  const el = $(sel).first();
  if (!el.length) return null;
  const v = attr ? el.attr(attr) : el.attr('content') || el.text();
  return v ? v.replace(/\s+/g, ' ').trim() : null;
}
