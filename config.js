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

  // Stores physically on Cabrini campus (a separate campus reached by
  // shuttle, ~8 min ride) rather than main campus — right now just Cascia.
  // The pricing engine treats any order crossing between this list and a
  // main-campus location as a bus trip, not a walk.
  cabriniStores: ["Cascia"],

  // Coordinates for each main-campus store, keyed by the matching entry in
  // `stores` above — feeds the pricing engine's distance calculation.
  // Cascia has no entry here; it's Cabrini-only (see cabriniStores).
  // Wawa and Connelly Center share coordinates on purpose — Villanova's
  // Wawa is physically inside Connelly Center.
  storeLocations: {
    "COVA": { lat: 40.03538279831171, lng: -75.34114479601725 },
    "Connelly Center": { lat: 40.035895224812755, lng: -75.34028222907769 },
    "St. Mary's": { lat: 40.04028393357511, lng: -75.34165260914898 },
    "Wawa": { lat: 40.035895224812755, lng: -75.34028222907769 },
    "Holy Grounds (Bartley)": { lat: 40.03481273056283, lng: -75.3383313736512 }
  },

  // Specific vendors inside each multi-vendor building — keyed by the
  // matching entry in `stores` above.
  vendorsByBuilding: {
    "COVA": ["The Italian Kitchen", "Acai Bowls", "COVA Greens", "The Corner Grill", "Southwest Station"],
    "Cascia": ["Local Grounds", "Menu Maker", "Rooted"],
    "Connelly Center": ["VSushi", "Nova Noodle Company"],
    "St. Mary's": ["2nd Storey Deli", "2nd Storey Pizza"]
  },

  // Dropoff locations across campus (dorms, academic buildings, athletic
  // facilities, etc.) — each has coordinates for the pricing engine's
  // distance calculation, and an optional `aliases` list of other names
  // people search by (e.g. "Cova" for Dougherty Hall). The stored/displayed
  // value is always `name`, never an alias.
  halls: [
    { name: "Good Counsel Hall", lat: 40.0312866779274, lng: -75.34302946810097 },
    { name: "Stanford Hall", lat: 40.031873, lng: -75.3414409 },
    { name: "Spit", aliases: ["Donahue Hall"], lat: 40.030817, lng: -75.342329 },
    { name: "St. Monica Hall", lat: 40.031441, lng: -75.340476 },
    { name: "St. Katharine Hall", lat: 40.0359424, lng: -75.3467392 },
    { name: "Caughlin Hall", lat: 40.030697, lng: -75.341243 },
    { name: "McGuire Hall", lat: 40.030455, lng: -75.341878 },
    { name: "Villanova Stadium", lat: 40.0329683, lng: -75.3366945 },
    { name: "Finneran Pavilion", lat: 40.0336756, lng: -75.3356619 },
    { name: "Jake Nevin Fieldhouse", lat: 40.033689, lng: -75.338198 },
    { name: "Davis Center", lat: 40.0346129, lng: -75.3366905 },
    { name: "Villanova School of Business", aliases: ["Curley"], lat: 40.03460621538991, lng: -75.33837645022221 },
    { name: "Driscoll Hall", lat: 40.035713208040185, lng: -75.3377895429578 },
    { name: "Health Services Building", lat: 40.034945, lng: -75.337334 },
    { name: "Sullivan Hall", lat: 40.035306, lng: -75.338904 },
    { name: "Sheehan Hall", lat: 40.0346233, lng: -75.3391682 },
    { name: "Vasey Hall", lat: 40.035138, lng: -75.340092 },
    { name: "Connelly Center", lat: 40.035771, lng: -75.340076 },
    { name: "Dougherty Hall", aliases: ["Pit", "Cova"], lat: 40.035388, lng: -75.341178 },
    { name: "Riley Ellipse", aliases: ["The Oreo"], lat: 40.03611794708997, lng: -75.34090586094126 },
    { name: "Vic Maggitti Hall", lat: 40.0364356, lng: -75.3405226 },
    { name: "Falvey Library", lat: 40.0373483, lng: -75.342114 },
    { name: "Mullen Center", lat: 40.033221, lng: -75.3392681 },
    { name: "Friar Hall", lat: 40.0336227, lng: -75.3401772 },
    { name: "Dobbin Hall", lat: 40.0343017, lng: -75.3414177 },
    { name: "Trinity Hall", lat: 40.0341574, lng: -75.3427271 },
    { name: "Arch Hall", lat: 40.0343297, lng: -75.3434217 },
    { name: "McGuinn Hall", lat: 40.0346314, lng: -75.3435028 },
    { name: "Canon Hall", lat: 40.03374596631312, lng: -75.3411380622797 },
    { name: "Hovnanian Hall", lat: 40.03374596631312, lng: -75.3411380622797 },
    { name: "Moriarty Hall", lat: 40.0347203093102, lng: -75.34452325059486 },
    { name: "Griffin Hall", lat: 40.034894183346836, lng: -75.3453715244523 },
    { name: "Simpson Hall", lat: 40.03575622022938, lng: -75.34571766497102 },
    { name: "O'Dwyer Hall", lat: 40.036056392836876, lng: -75.3468479403266 },
    { name: "Delurey Hall", lat: 40.0367728221752, lng: -75.34667752806465 },
    { name: "Drosdick Hall", lat: 40.036793, lng: -75.345845 },
    { name: "Tolentine Hall", lat: 40.03673383474817, lng: -75.34441822115622 },
    { name: "St. Thomas of Villanova Church", lat: 40.03590228771146, lng: -75.34336376922546 },
    { name: "White Hall", lat: 40.037434, lng: -75.344356 },
    { name: "John Barry Hall", lat: 40.03794510492519, lng: -75.34397746034692 },
    { name: "Old Falvey", lat: 40.037427622214054, lng: -75.34244327719956 },
    { name: "Mendel", lat: 40.03795605689782, lng: -75.34285453841622 },
    { name: "Mendel Field", lat: 40.037455002350065, lng: -75.34360553715968 },
    { name: "Corr Hall", lat: 40.036540833942084, lng: -75.3413157128297 },
    { name: "Garey Hall", lat: 40.0394363, lng: -75.3397663 },
    { name: "Charles Widger School of Law", lat: 40.03859460701951, lng: -75.3391460311812 },
    { name: "St. Mary's Hall", lat: 40.04017705015808, lng: -75.34128728014188 },
    { name: "Jackson Hall", lat: 40.04145124511974, lng: -75.34428719922299 },
    { name: "St. Clare Hall", lat: 40.04202278985076, lng: -75.34448582398959 },
    { name: "Welsh Hall", lat: 40.0421771, lng: -75.3431094 },
    { name: "Rudolph Hall", lat: 40.04186548443934, lng: -75.34312969627278 },
    { name: "Moulden Hall", lat: 40.04124150273234, lng: -75.34297216628548 },
    { name: "Gallen Hall", lat: 40.04078006720894, lng: -75.34397898837825 },
    { name: "Farley Hall", lat: 40.0401403446131, lng: -75.34362283362435 },
    { name: "Klekotka Hall", lat: 40.040497, lng: -75.342444 },
    { name: "Higgins Soccer Complex", lat: 40.0420175463429, lng: -75.34567072345932 },
    { name: "St. Rita's Hall", lat: 40.036062748385866, lng: -75.34275727118164 },
    { name: "Austin Hall", lat: 40.03590077338675, lng: -75.3417884685547 },
    { name: "Alumni Hall", lat: 40.036454075561004, lng: -75.3425864957611 },
    { name: "Fedigan Hall", lat: 40.037376623011944, lng: -75.34550345120947 },

    // Cabrini campus halls — no coordinates (a straight-line distance would
    // be meaningless for a bus trip); the pricing engine treats these as
    // their own zone instead. See `cabriniStores` above.
    { name: "Xavier Hall", cabrini: true },
    { name: "Thomas Hall", cabrini: true },
    { name: "Josephine Hall", cabrini: true },
    { name: "Francesca Hall", cabrini: true },
    { name: "Stanton Hall", cabrini: true },
    { name: "Nicholas Hall", cabrini: true },
    { name: "Rosseter Hall", cabrini: true },
    { name: "Montefalco Hall", cabrini: true },
    { name: "Iadarola Center", cabrini: true },
    { name: "Grace Hall", cabrini: true },
    { name: "Ortiz Hall", cabrini: true },
    { name: "Bellesini Hall", cabrini: true },
    { name: "Dixon Center", cabrini: true }
  ]
};
