import { faqService } from './service.js';

export const resolvers = {
  Query: {
    faqs: () => faqService.getAll(),
    faq: (_: any, { id }: { id: string }) => ({ id, name: 'Test' }),
  },
  Mutation: {
    createFaq: async (_: any, { name }: { name: string }) => {
      const result = await faqService.create(name);
      return {
        success: true,
        message: 'Faq created successfully',
        data: result,
      };
    },
  },
};