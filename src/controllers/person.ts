import { Request, Response } from "express";
import { personService } from "../services/person.js";
import {
  createPersonSchema,
  updatePersonSchema,
  personIdSchema,
} from "../schemas/person.js";
import { ZodError } from "zod";

export class PersonController {
  async create(req: Request, res: Response) {
    try {
      const validatedData = createPersonSchema.parse(req.body);
      const person = await personService.createPerson(validatedData);
      res.status(201).json(person);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: "Validation failed",
          details: error.issues,
        });
      }
      res.status(500).json({
        error: "Failed to create person",
        message: "Consulte os registros do servidor.",
      });
    }
  }

  async getAll(_req: Request, res: Response) {
    try {
      const people = await personService.getAllPeople();
      res.status(200).json(people);
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch people",
        message: "Consulte os registros do servidor.",
      });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const { id } = personIdSchema.parse(req.params);
      const person = await personService.getPersonById(id);

      if (!person) {
        return res.status(404).json({ error: "Person not found" });
      }

      res.status(200).json(person);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: "Invalid ID format",
          details: error.issues,
        });
      }
      res.status(500).json({
        error: "Failed to fetch person",
        message: "Consulte os registros do servidor.",
      });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const { id } = personIdSchema.parse(req.params);
      const validatedData = updatePersonSchema.parse(req.body);
      const person = await personService.updatePerson(id, validatedData);
      res.status(200).json(person);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: "Validation failed",
          details: error.issues,
        });
      }
      res.status(500).json({
        error: "Failed to update person",
        message: "Consulte os registros do servidor.",
      });
    }
  }

  async delete(req: Request, res: Response) {
    try {
      const { id } = personIdSchema.parse(req.params);
      await personService.deletePerson(id);
      res.status(204).send();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: "Invalid ID format",
          details: error.issues,
        });
      }
      res.status(500).json({
        error: "Failed to delete person",
        message: "Consulte os registros do servidor.",
      });
    }
  }
}

export const personController = new PersonController();
