import { Request, Response } from "express";
import { leaderboardService } from "../services/leaderboard.js";
import {
  createLeaderboardSchema,
  updateLeaderboardSchema,
  leaderboardIdSchema,
} from "../schemas/leaderboard.js";
import { ZodError } from "zod";

export class LeaderboardController {
  async create(req: Request, res: Response) {
    try {
      const validatedData = createLeaderboardSchema.parse(req.body);
      const leaderboard =
        await leaderboardService.createLeaderboard(validatedData);
      res.status(201).json(leaderboard);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: "Validation failed",
          details: error.issues,
        });
      }
      res.status(500).json({
        error: "Failed to create leaderboard",
        message: "Consulte os registros do servidor.",
      });
    }
  }

  async getAll(req: Request, res: Response) {
    try {
      const leaderboards = await leaderboardService.getAllLeaderboards();
      res.status(200).json(leaderboards);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch leaderboards",
        message: "Consulte os registros do servidor.",
      });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const { id } = leaderboardIdSchema.parse(req.params);
      const leaderboard = await leaderboardService.getLeaderboardById(id);

      if (!leaderboard) {
        return res.status(404).json({ error: "Leaderboard not found" });
      }

      res.status(200).json(leaderboard);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: "Invalid ID format",
          details: error.issues,
        });
      }
      res.status(500).json({
        error: "Failed to fetch leaderboard",
        message: "Consulte os registros do servidor.",
      });
    }
  }

  async getBySemester(req: Request, res: Response) {
    try {
      const semesterParam = req.params.semester;
      const semesterDate = new Date(semesterParam);

      if (isNaN(semesterDate.getTime())) {
        return res.status(400).json({
          error: "Invalid semester format",
          details: "Semester must be a valid date string",
        });
      }

      const semesterStart = new Date(
        semesterDate.getFullYear(),
        Math.floor(semesterDate.getMonth() / 6) * 6,
        1,
      );

      const leaderboards =
        await leaderboardService.getLeaderboardsBySemester(semesterStart);
      res.status(200).json(leaderboards);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch leaderboards by semester",
        message: "Consulte os registros do servidor.",
      });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const { id } = leaderboardIdSchema.parse(req.params);
      const validatedData = updateLeaderboardSchema.parse(req.body);
      const leaderboard = await leaderboardService.updateLeaderboard(
        id,
        validatedData,
      );
      res.status(200).json(leaderboard);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: "Validation failed",
          details: error.issues,
        });
      }
      res.status(500).json({
        error: "Failed to update leaderboard",
        message: "Consulte os registros do servidor.",
      });
    }
  }

  async delete(req: Request, res: Response) {
    try {
      const { id } = leaderboardIdSchema.parse(req.params);
      await leaderboardService.deleteLeaderboard(id);
      res.status(204).send();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: "Invalid ID format",
          details: error.issues,
        });
      }
      res.status(500).json({
        error: "Failed to delete leaderboard",
        message: "Consulte os registros do servidor.",
      });
    }
  }

  async getByPersonId(req: Request, res: Response) {
    try {
      const personId = req.params.personId;
      const leaderboards =
        await leaderboardService.getLeaderboardsByPersonId(personId);
      res.status(200).json(leaderboards);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch leaderboards",
        message: "Consulte os registros do servidor.",
      });
    }
  }
}

export const leaderboardController = new LeaderboardController();
