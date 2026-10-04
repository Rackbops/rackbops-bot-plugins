/**
 * Test fixtures for the want-list watcher (want.test.ts), imported only by tests.
 *
 * `BGG_THING` is HAND-WRITTEN to the shape BGG documents for `xmlapi2/thing?...&marketplace=1`
 * (boardgamegeek.com/wiki/page/BGG_XML_API2, read 2026-09-29), not a captured response: BGG has not
 * yet approved the tracker's application, so no token exists to capture one with. Replace it with a
 * real response once `TRACKER_BGG_TOKEN` exists (rackbops-bot-plugins#83).
 */

export const BGG_THING = `<?xml version="1.0" encoding="utf-8"?>
<items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <item type="boardgameexpansion" id="300580">
    <thumbnail>https://cf.geekdo-images.com/thumb.jpg</thumbnail>
    <name type="primary" sortindex="1" value="Wingspan: Oceania Expansion" />
    <name type="alternate" sortindex="1" value="Wingspan: Ozeanien" />
    <marketplacelistings>
      <listing>
        <listdate value="Sat, 26 Sep 2026 14:02:11 +0000" />
        <price currency="USD" value="32.00" />
        <condition value="likenew" />
        <notes value="Punched, sleeved &amp; complete. &lt;b&gt;No&lt;/b&gt; trades." />
        <link href="https://boardgamegeek.com/geekmarket/product/4100001" title="marketlisting" />
      </listing>
      <listing>
        <listdate value="Fri, 02 Oct 2026 09:30:00 +0000" />
        <price currency="EUR" value="29.50" />
        <condition value="new" />
        <link title="marketlisting" href="https://boardgamegeek.com/geekmarket/product/4100002" />
      </listing>
      <listing>
        <listdate value="Fri, 02 Oct 2026 10:00:00 +0000" />
        <price currency="USD" value="55.00" />
        <condition value="new" />
        <link href="javascript:alert(1)" title="marketlisting" />
      </listing>
    </marketplacelistings>
  </item>
</items>
`;

/** A shop's search page: an ItemList of three products (one with a relative address), and a breadcrumb. */
export function shopSearch(items: { name: string; url: string; price?: number; condition?: string; seller?: string }[]): string {
  const ld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Product",
        name: it.name,
        url: it.url,
        offers: {
          "@type": "Offer",
          ...(it.price !== undefined ? { price: it.price.toFixed(2), priceCurrency: "USD" } : {}),
          ...(it.condition ? { itemCondition: `https://schema.org/${it.condition}Condition` } : {}),
          ...(it.seller ? { seller: { "@type": "Organization", name: it.seller } } : {}),
        },
      },
    })),
  };
  const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Games" }] };
  return `<html><head><title>Search</title>
<script type="application/ld+json">${JSON.stringify(crumbs)}</script>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head><body><h1>Results</h1></body></html>`;
}
