import { prisma } from "../PrismaClient.js";
import { CreatePersonInput, UpdatePersonInput } from "../schemas/person.js";

export class PersonService {
  async createPerson(data: CreatePersonInput) {
    return await prisma.person.create({
      data: {
        ...data,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
      },
      include: {
        leaderboards: true,
      },
    });
  }

  async getAllPeople() {
    return await prisma.person.findMany({
      include: {
        leaderboards: true,
      },
    });
  }

  async getPersonById(id: string) {
    return await prisma.person.findUnique({
      where: { id },
      include: {
        leaderboards: true,
      },
    });
  }

  async updatePerson(id: string, data: UpdatePersonInput) {
    const updateData: any = { ...data };
    if (data.dateOfBirth) {
      updateData.dateOfBirth = new Date(data.dateOfBirth);
    }

    return await prisma.person.update({
      where: { id },
      data: updateData,
      include: {
        leaderboards: true,
      },
    });
  }

  async deletePerson(id: string) {
    return await prisma.person.delete({
      where: { id },
    });
  }
}

export const personService = new PersonService();
