# Flipwise demo

This repository deploys the interactive Flipwise prototype with GitHub Pages. A push to `main` triggers the existing Pages workflow.

## Demo search

The item search includes direct web-search links for eBay, Depop, Poshmark, Mercari, Vinted, Grailed, and Etsy vintage listings. This works without account credentials, but the links open search-engine results rather than combining listings inside Flipwise.

For combined search cards and estimates, deploy `api/worker.js` to Cloudflare Workers and configure a Brave Search API key as the `BRAVE_API_KEY` Worker secret. Set the Worker `ALLOWED_ORIGIN` variable to `https://anishiscool123.github.io`. Then paste the Worker URL into **Research item → Connect live marketplace search**.

The Worker uses domain-filtered Brave results for each supported marketplace. To add structured eBay listings and photo-based eBay matching, also configure `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` as Worker secrets. eBay production access for the Browse API may require approval. Photo search uses eBay matches to seed searches on the other marketplaces; it is not a universal reverse-image search across every resale site.

Search results can be incomplete or stale. Structured eBay prices are distinct from prices inferred from web snippets. Estimates use the median of priced results, not a guaranteed sale price. The historical trend graph remains sample data.

## APIs

- [Brave Search API](https://brave.com/search/api/)
- [eBay Browse API](https://developer.ebay.com/api-docs/buy/api-browse.html)
- [eBay Buy API production requirements](https://developer.ebay.com/api-docs/buy/buy-requirements.html)

Never put provider keys in `index.html` or commit them to this repository.
