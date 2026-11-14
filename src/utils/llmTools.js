export const storeTools = [{
  functionDeclarations: [
    {
      name: "search_products",
      description: "Search the store catalog to find products OR retrieve specifications/details (dimensions, materials, height, weight, description) about a specific product.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Core product keywords only, e.g. 'combat knife' or 'Nagamaki'. No filler words." },
          intentType: {
            type: "string",
            enum: ["purchase", "product_info"],
            description: "Use 'purchase' when the shopper wants to browse, buy, or see options. Use 'product_info' when asking a specific question about a product's specs, dimensions, materials, or details."
          },
          maxPrice: { type: "number", description: "Upper budget limit, if stated." },
          minPrice: { type: "number", description: "Lower budget limit, if stated." },
          inStockOnly: { type: "boolean", description: "true unless the shopper asks for sold-out items." }
        },
        required: ["query", "intentType"]
      }
    },
    {
      name: "get_store_info",
      description: "Retrieve official store information from the website including contact details (email, phone, address), return/refund policy, shipping policy, terms of service, privacy policy, or company background (About Us).",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: ["contact", "refund_policy", "shipping_policy", "terms_of_service", "privacy_policy", "about", "general"],
            description: "The category of store or webpage information requested by the user."
          }
        },
        required: ["topic"]
      }
    }
  ]
}];