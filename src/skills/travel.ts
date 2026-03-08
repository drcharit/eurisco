import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";
import type { Skill, ToolContext } from "./types.js";
import { searchFlights, searchAirportCode } from "../services/flights.js";

const S = SchemaType;

export const travelSkill: Skill = {
  name: "travel",
  description:
    "Search flights between airports and look up airport codes. " +
    "Use for any travel query — finding flights, comparing options, checking routes and prices.",

  tools: [
    {
      name: "flight_search",
      description:
        "Search for flights between airports. Use IATA codes (e.g. BLR, SYD). " +
        "If you don't know the code, use airport_search first. Dates: YYYY-MM-DD. " +
        "IMPORTANT: Present ALL results to the user with airline, flight number, times, duration, stops, and price.",
      parameters: {
        type: S.OBJECT,
        properties: {
          origin: { type: S.STRING, description: "Origin IATA code" },
          destination: { type: S.STRING, description: "Destination IATA code" },
          departure_date: { type: S.STRING, description: "Departure date YYYY-MM-DD" },
          return_date: { type: S.STRING, description: "Return date YYYY-MM-DD (optional)" },
          adults: { type: S.INTEGER, description: "Number of adults (default 1)" },
          max_results: { type: S.INTEGER, description: "Max results (default 5)" },
        },
        required: ["origin", "destination", "departure_date"],
      },
    },
    {
      name: "airport_search",
      description: "Look up IATA airport codes by city or airport name.",
      parameters: {
        type: S.OBJECT,
        properties: {
          keyword: { type: S.STRING, description: "City or airport name" },
        },
        required: ["keyword"],
      },
    },
  ] as FunctionDeclaration[],

  createHandlers(ctx: ToolContext) {
    return {
      flight_search: (args: Record<string, unknown>) =>
        searchFlights(ctx.amadeusClientId, ctx.amadeusClientSecret, {
          origin: args["origin"] as string,
          destination: args["destination"] as string,
          departureDate: args["departure_date"] as string,
          returnDate: args["return_date"] as string | undefined,
          adults: (args["adults"] as number) ?? 1,
          maxResults: (args["max_results"] as number) ?? 5,
        }),
      airport_search: (args: Record<string, unknown>) =>
        searchAirportCode(
          ctx.amadeusClientId,
          ctx.amadeusClientSecret,
          args["keyword"] as string,
        ),
    };
  },
};
