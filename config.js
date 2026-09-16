// Editable lists — tweak these to match what's actually around campus.
module.exports = {
  // Places a runner can pick food up from. Buildings listed in
  // vendorsByBuilding below are multi-vendor — the client shows a second
  // "which spot inside?" dropdown once one of those is picked.
  stores: [
    "COVA",
    "Cascia",
    "Connelly Center",
    "St. Mary's",
    "Wawa",
    "Holy Grounds (Bartley)"
  ],

  // Specific vendors inside each multi-vendor building — keyed by the
  // matching entry in `stores` above.
  vendorsByBuilding: {
    "COVA": ["The Italian Kitchen", "Acai Bowls", "COVA Greens", "The Corner Grill", "Southwest Station"],
    "Cascia": ["Local Grounds", "Menu Maker", "Rooted"],
    "Connelly Center": ["VSushi", "Nova Noodle Company"],
    "St. Mary's": ["2nd Storey Deli", "2nd Storey Pizza"]
  },

  // Dropoff locations (residence halls / campus areas)
  halls: [
    // Main campus
    "Alumni Hall",
    "Austin Hall",
    "Caughlin Hall",
    "Corr Hall",
    "Delurey Hall",
    "Fedigan Hall",
    "Good Counsel Hall",
    "McGuire Hall",
    "Moriarty Hall",
    "O'Dwyer Hall",
    "Sheehan Hall",
    "Sullivan Hall",
    "Stanford Hall",
    "St. Mary's Hall",
    "St. Katharine Hall",
    "St. Monica Hall",
    "St. Rita Hall",
    // West Campus Apartments
    "Farley Hall",
    "Gallen Hall",
    "Jackson Hall",
    "Klekotka Hall",
    "Moulden Hall",
    "Rudolph Hall",
    "St. Clare Hall",
    "Welsh Hall",
    // The Commons (along Lancaster Avenue)
    "Canon Hall",
    "Dobbin Hall",
    "Friar Hall",
    "Hovnanian Hall",
    "McGuinn Hall"
  ]
};
