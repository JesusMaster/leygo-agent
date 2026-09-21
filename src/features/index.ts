import { typeDefs as faqTypeDefs } from './faq/typeDefs.js';
import { resolvers as faqResolvers } from './faq/resolvers.js';
export const typeDefs = [faqTypeDefs, 'type Query { status: String }'];
export const resolvers = [faqResolvers, { Query: { status: () => 'Functioning' } }];
