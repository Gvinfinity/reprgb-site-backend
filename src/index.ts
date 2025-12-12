import express from "express";
import { apiReference } from "@scalar/express-api-reference";
import personRouter from "./routers/person";
import leaderboardRouter from "./routers/leaderboard";
import { openApiDocument } from "./openapi/config";

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/people', personRouter);
app.use('/leaderboards', leaderboardRouter);

// API Reference
app.use(
  '/reference',
  apiReference({
    spec: {
      content: openApiDocument,
    },
  })
);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Server is running' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

