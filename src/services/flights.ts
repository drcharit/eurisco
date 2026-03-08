const BASE_URL = "https://test.api.amadeus.com";

interface AmadeusToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: AmadeusToken | null = null;

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.accessToken;
  }

  const res = await fetch(`${BASE_URL}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
  });

  if (!res.ok) throw new Error(`Amadeus auth failed: ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in: number };

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  return cachedToken.accessToken;
}

export interface FlightSearchArgs {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults?: number;
  maxResults?: number;
}

export async function searchFlights(
  clientId: string,
  clientSecret: string,
  args: FlightSearchArgs
): Promise<string> {
  const token = await getToken(clientId, clientSecret);

  const params = new URLSearchParams({
    originLocationCode: args.origin.toUpperCase(),
    destinationLocationCode: args.destination.toUpperCase(),
    departureDate: args.departureDate,
    adults: String(args.adults ?? 1),
    max: String(args.maxResults ?? 5),
    currencyCode: "USD",
  });

  if (args.returnDate) {
    params.set("returnDate", args.returnDate);
  }

  const url = `${BASE_URL}/v2/shopping/flight-offers?${params}`;
  console.log(`[flights] searching: ${url}`);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    return `Flight search error: ${res.status} — ${err.slice(0, 500)}`;
  }

  const data = await res.json() as { data: FlightOffer[]; dictionaries?: { carriers?: Record<string, string> } };
  const carriers = data.dictionaries?.carriers ?? {};

  if (!data.data || data.data.length === 0) {
    return `No flights found from ${args.origin} to ${args.destination} on ${args.departureDate}`;
  }

  const header = `FLIGHTS: ${args.origin.toUpperCase()} → ${args.destination.toUpperCase()} on ${args.departureDate} (${data.data.length} options)\nIMPORTANT: Present ALL flight details below to the user exactly as shown. Do NOT summarize or omit any flights.\n`;
  return header + data.data.map((offer, i) => `Option ${i + 1}:\n${formatOffer(offer, carriers)}`).join("\n\n---\n\n");
}

interface FlightOffer {
  id: string;
  price: { total: string; currency: string };
  itineraries: Itinerary[];
}

interface Itinerary {
  duration: string;
  segments: Segment[];
}

interface Segment {
  departure: { iataCode: string; at: string };
  arrival: { iataCode: string; at: string };
  carrierCode: string;
  number: string;
  duration: string;
}

function formatOffer(offer: FlightOffer, carriers: Record<string, string>): string {
  const lines = [`Price: ${offer.price.currency} ${offer.price.total}`];

  for (let i = 0; i < offer.itineraries.length; i++) {
    const itin = offer.itineraries[i]!;
    const label = i === 0 ? "Outbound" : "Return";
    lines.push(`\n${label} (${itin.duration}):`);

    for (const seg of itin.segments) {
      const airline = carriers[seg.carrierCode] ?? seg.carrierCode;
      const depTime = seg.departure.at.slice(11, 16);
      const arrTime = seg.arrival.at.slice(11, 16);
      lines.push(
        `  ${airline} ${seg.carrierCode}${seg.number}: ${seg.departure.iataCode} ${depTime} → ${seg.arrival.iataCode} ${arrTime} (${seg.duration})`
      );
    }
  }

  return lines.join("\n");
}

export async function searchAirportCode(
  clientId: string,
  clientSecret: string,
  keyword: string
): Promise<string> {
  const token = await getToken(clientId, clientSecret);

  const params = new URLSearchParams({
    subType: "AIRPORT",
    keyword: keyword,
    "page[limit]": "5",
  });

  const res = await fetch(`${BASE_URL}/v1/reference-data/locations?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) return `Airport lookup error: ${res.status}`;

  const data = await res.json() as { data: { iataCode: string; name: string; address: { cityName: string; countryCode: string } }[] };

  if (!data.data || data.data.length === 0) return `No airports found for "${keyword}"`;

  return data.data
    .map((a) => `${a.iataCode} — ${a.name}, ${a.address.cityName}, ${a.address.countryCode}`)
    .join("\n");
}
