import { prisma } from "../PrismaClient.js";
import {
  CreateLeaderboardInput,
  UpdateLeaderboardInput,
} from "../schemas/leaderboard.js";

export class LeaderboardService {
  async createLeaderboard(data: CreateLeaderboardInput) {
    return await prisma.leaderboard.create({
      data: {
        semester: new Date(data.semester),
        style: data.style,
        personId: data.personId,
        sleepingMisses:
          data.sleepingMisses?.map((date) => new Date(date)) || [],
        classMisses: data.classMisses?.map((date) => new Date(date)) || [],
      },
      include: {
        person: true,
      },
    });
  }

  async getAllLeaderboards() {
    return await prisma.leaderboard.findMany({
      include: {
        person: true,
      },
    });
  }

  async getLeaderboardById(id: number) {
    return await prisma.leaderboard.findUnique({
      where: { id },
      include: {
        person: true,
      },
    });
  }

  async updateLeaderboard(id: number, data: UpdateLeaderboardInput) {
    const updateData: any = { ...data };
    if (data.semester) {
      updateData.semester = new Date(data.semester);
    }
    if (data.sleepingMisses) {
      updateData.sleepingMisses = data.sleepingMisses.map(
        (date) => new Date(date),
      );
    }
    if (data.classMisses) {
      updateData.classMisses = data.classMisses.map((date) => new Date(date));
    }

    return await prisma.leaderboard.update({
      where: { id },
      data: updateData,
      include: {
        person: true,
      },
    });
  }

  async deleteLeaderboard(id: number) {
    return await prisma.leaderboard.delete({
      where: { id },
    });
  }

  async getLeaderboardsByPersonId(personId: string) {
    return await prisma.leaderboard.findMany({
      where: { personId },
      include: {
        person: true,
      },
    });
  }

  async getLeaderboardsBySemester(semester: Date) {
    return await prisma.leaderboard.findMany({
      where: { semester },
      include: {
        person: true,
      },
    });
  }
}

export const leaderboardService = new LeaderboardService();
