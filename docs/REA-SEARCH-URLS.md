# REA rent search URLs

Spike notes (2026-10-01) for reading REA's own search filters and writing them back. Captured by setting each control in REA's Filters dialog and reading the URL it produced, then checking that a hand-built URL is read back by REA's UI (it was: chips and counts matched). Undocumented and liable to change: anything built on this needs URL fixtures and a drift warning like the listing shapes.

## Shape

```
/rent/[property-<types>-][with-<beds>-bedrooms-|with-studio-][between-<min>-<max>-]in-<places>/list-<n>?<query>
```

| Filter | Where | Format | Example |
|---|---|---|---|
| Places | path | `in-<suburb>,+<state>+<postcode>`, several joined with `;+` | `in-bondi,+nsw+2026;+manly,+nsw+2095` |
| Page | path | `list-<n>` | `list-2` |
| Property type | path | `property-<slug>`, several joined with `-` | `property-house-townhouse-villa` |
| Type slugs | | `house`, `townhouse`, `unit+apartment` (one checkbox, "Apartment & Unit"), `villa`; dialog has more types below these | |
| Min bedrooms | path | `with-<n>-bedrooms`, or `with-studio` | `with-2-bedrooms` |
| Rent | path | `between-<min>-<max>`, `any` for an open end | `between-500-any`, `between-any-900` |
| Max bedrooms | query | `maxBeds=<n>` | `maxBeds=3` |
| Bathrooms (min) | query | `numBaths=<n>` | `numBaths=1` |
| Car spaces (min) | query | `numParkingSpaces=<n>` | `numParkingSpaces=1` |
| Available before | query | `availableBefore=YYYY-MM-DD`; "Avail. now" is today | `availableBefore=2026-10-31` |
| Surrounding areas | query | `includeSurrounding=false` when unticked (absent = included) | |
| Requirements | query | `misc=` comma list | `misc=ex-deposit-taken,furnished,pets-allowed` |
| Features | query | `checkedFeatures=` comma list of labels, lower case; also copied into `keywords` | `checkedFeatures=dishwasher,air conditioning` |
| Keywords | query | `keywords=` comma list (typed words; ticked features too) | `keywords=balcony` |
| Sort | query | `activeSort=` | `activeSort=price-asc` |
| Tracking | query | `source`, `sourcePage`, `sourceElement`: REA's analytics, safe to drop | |

## Control values REA offers

- Rent: fixed steps only: $50 to $750 in $25 steps, $800 to $1,000 in $50, $1,100 to $2,000 in $100, then $2,500 to $5,000 in $500. A toolkit value between steps must round its min down and its max up, so REA never drops a listing the toolkit would keep.
- Bedrooms: Studio, 1 to 6 (min and max). Bathrooms and car spaces: 1+ to 6+.
- Available date: "Avail. now" or "Before <date>" for about six weeks ahead. There is no available-from (the reason this script exists).
- Feature checkboxes: requirements (furnished, pets considered), outdoor (pool, garage, balcony, outdoor area, undercover parking, shed, fully fenced, outdoor spa, tennis court), indoor (ensuite, dishwasher, study, built in robes, alarm, broadband, floorboards, gym, rumpus room, workshop), climate and energy (air conditioning, solar panels, heating, fireplace, high energy efficiency, water tank, solar hot water), accessibility (single storey, step free entry, wide doorways, elevator, roll in shower, grab rails, accessible parking), and "Exclude properties secured by a deposit" (`misc=ex-deposit-taken`).
- REA also has an "AI search" tab beside Classic search (not explored).

## Mapping to the toolkit

| Toolkit filter | REA can narrow it | Notes |
|---|---|---|
| Rent min/max (weekly) | yes, path | snap to REA's steps (min down, max up) |
| Beds / baths / cars min | yes | studio = 0 beds |
| Property type | yes, path | toolkit types are REA's display names; map Apartment and Unit to `unit+apartment` |
| Available to / within | yes, `availableBefore` | REA offers about six weeks; later dates leave it off |
| Available from | no | toolkit only |
| Hide taken | partly, `misc=ex-deposit-taken` | REA's own flag; the toolkit also reads the text |
| Exact suburbs only | yes, `includeSurrounding=false` | |
| Amenities (pets, furnished, pool, dishwasher, air con…) | yes, `misc` / `checkedFeatures` | REA matches by its feature tags and text; the toolkit keeps its own reading as the final say |
| Keywords | loosely, `keywords` | REA's matching differs (no `-word`, no `a|b`): leave to the toolkit |
| Distance, cash to move, floor size, lease, inspections, heads-up | no | toolkit only |
