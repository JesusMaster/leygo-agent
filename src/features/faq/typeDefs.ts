export const typeDefs = `#graphql
  type Faq {
    id: ID!
    name: String
  }

  type FaqResponse {
    success: Boolean!
    message: String!
    data: Faq
  }

  type Query {
    faqs: [Faq]
    faq(id: ID!): Faq
  }

  type Mutation {
    createFaq(name: String!): FaqResponse
  }
`;