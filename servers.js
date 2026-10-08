// Brawl Stars game servers, grouped the way the in-game region list is.
//
// The city names line up with Google Cloud regions, so each row below says which GCP
// region sits in that city. That is what gets measured: not the game server itself —
// nothing in a browser can reach a UDP game server — but a machine in the same
// building, which is as close as a web page can honestly get.
//
// `via` names a different city when the server's own city has no cloud region to
// measure. Those rows are marked in the UI so nobody reads them as exact.

export const GROUPS = [
  ["NA", "North America", "#3FB950"],
  ["SA", "South America", "#F0883E"],
  ["EU", "Europe", "#58A6FF"],
  ["ME", "Middle East", "#BC8CFF"],
  ["ASIA", "Asia", "#E3B341"],
  ["OCE", "Oceania", "#2DD4BF"],
  ["CN", "China only", "#E8364D"],
];

// group, label, city, flag, gcp region, [via]
export const SERVERS = [
  ["NA", "Virginia", "Ashburn", "🇺🇸", "us-east4"],
  ["NA", "Dallas", "Dallas", "🇺🇸", "us-south1"],
  ["NA", "LosAngeles", "Los Angeles", "🇺🇸", "us-west2"],
  ["NA", "Oregon", "Boardman", "🇺🇸", "us-west1"],
  ["NA", "Miami", "Miami", "🇺🇸", "us-east1", "South Carolina"],

  ["SA", "Brasil", "Sao Paulo", "🇧🇷", "southamerica-east1"],
  ["SA", "Chile", "Santiago", "🇨🇱", "southamerica-west1"],
  ["SA", "Peru", "Lima", "🇵🇪", "southamerica-west1", "Santiago"],

  ["EU", "Germany", "Frankfurt", "🇩🇪", "europe-west3"],
  ["EU", "Italy", "Milan", "🇮🇹", "europe-west8"],
  ["EU", "Finland", "Hamina", "🇫🇮", "europe-north1"],
  ["EU", "Netherlands", "Eemshaven", "🇳🇱", "europe-west4"],

  ["ME", "Dammam", "Dammam", "🇸🇦", "me-central2"],
  ["ME", "Riyadh", "Riyadh", "🇸🇦", "me-central2", "Dammam"],
  ["ME", "Qatar", "Doha", "🇶🇦", "me-central1"],

  ["ASIA", "HongKong", "Hong Kong", "🇭🇰", "asia-east2"],
  ["ASIA", "Japan", "Tokyo", "🇯🇵", "asia-northeast1"],
  ["ASIA", "Singapore", "Singapore", "🇸🇬", "asia-southeast1"],
  ["ASIA", "India", "Mumbai", "🇮🇳", "asia-south1"],
  ["ASIA", "Indonesia", "Jakarta", "🇮🇩", "asia-southeast2"],

  ["OCE", "Australia", "Sydney", "🇦🇺", "australia-southeast1"],

  ["CN", "China-East", "Shanghai", "🇨🇳", null],
  ["CN", "China-North", "Beijing", "🇨🇳", null],
].map(([group, label, city, flag, gcp, via]) => ({ group, label, city, flag, gcp, via: via || null }));

// Thresholds for the coloured dot, in milliseconds.
export const BANDS = [[50, "good"], [100, "ok"], [180, "poor"]];
export const bandOf = ms => (ms == null ? "none" : (BANDS.find(([max]) => ms < max) || [0, "bad"])[1]);
