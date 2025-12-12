import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  createPersonSchema,
  updatePersonSchema,
  personIdSchema,
} from '../schemas/person';
import {
  createLeaderboardSchema,
  updateLeaderboardSchema,
  leaderboardIdSchema,
} from '../schemas/leaderboard';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// Define Person routes
registry.registerPath({
  method: 'post',
  path: '/api/people',
  summary: 'Create a new person',
  tags: ['People'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: createPersonSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Person created successfully',
    },
    400: {
      description: 'Validation error',
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/people',
  summary: 'Get all people',
  tags: ['People'],
  responses: {
    200: {
      description: 'List of all people',
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/people/{id}',
  summary: 'Get person by ID',
  tags: ['People'],
  request: {
    params: personIdSchema,
  },
  responses: {
    200: {
      description: 'Person found',
    },
    404: {
      description: 'Person not found',
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/people/{id}',
  summary: 'Update person by ID',
  tags: ['People'],
  request: {
    params: personIdSchema,
    body: {
      content: {
        'application/json': {
          schema: updatePersonSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Person updated successfully',
    },
    400: {
      description: 'Validation error',
    },
    404: {
      description: 'Person not found',
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/people/{id}',
  summary: 'Delete person by ID',
  tags: ['People'],
  request: {
    params: personIdSchema,
  },
  responses: {
    204: {
      description: 'Person deleted successfully',
    },
    404: {
      description: 'Person not found',
    },
  },
});

// Define Leaderboard routes
registry.registerPath({
  method: 'post',
  path: '/api/leaderboards',
  summary: 'Create a new leaderboard',
  tags: ['Leaderboards'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: createLeaderboardSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Leaderboard created successfully',
    },
    400: {
      description: 'Validation error',
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/leaderboards',
  summary: 'Get all leaderboards',
  tags: ['Leaderboards'],
  responses: {
    200: {
      description: 'List of all leaderboards',
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/leaderboards/{id}',
  summary: 'Get leaderboard by ID',
  tags: ['Leaderboards'],
  request: {
    params: leaderboardIdSchema,
  },
  responses: {
    200: {
      description: 'Leaderboard found',
    },
    404: {
      description: 'Leaderboard not found',
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/leaderboards/{id}',
  summary: 'Update leaderboard by ID',
  tags: ['Leaderboards'],
  request: {
    params: leaderboardIdSchema,
    body: {
      content: {
        'application/json': {
          schema: updateLeaderboardSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Leaderboard updated successfully',
    },
    400: {
      description: 'Validation error',
    },
    404: {
      description: 'Leaderboard not found',
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/leaderboards/{id}',
  summary: 'Delete leaderboard by ID',
  tags: ['Leaderboards'],
  request: {
    params: leaderboardIdSchema,
  },
  responses: {
    204: {
      description: 'Leaderboard deleted successfully',
    },
    404: {
      description: 'Leaderboard not found',
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/leaderboards/person/{personId}',
  summary: 'Get all leaderboards for a specific person',
  tags: ['Leaderboards'],
  responses: {
    200: {
      description: 'List of leaderboards for the person',
    },
  },
});

const generator = new OpenApiGeneratorV3(registry.definitions);

export const openApiDocument = generator.generateDocument({
  openapi: '3.0.0',
  info: {
    title: 'RepRGB Site Backend API',
    version: '1.0.0',
    description: 'API for managing people and leaderboards',
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Development server',
    },
  ],
});
