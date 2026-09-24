ALTER TABLE "Task" ADD COLUMN "weightHours" DOUBLE PRECISION;
ALTER TABLE "Task" ADD CONSTRAINT "Task_weightHours_check" CHECK ("weightHours" IS NULL OR ("weightHours" >= 0 AND "weightHours" <= 10000));

ALTER TYPE "TaskLocation" ADD VALUE 'GARAGE';
ALTER TYPE "TaskLocation" ADD VALUE 'LAUNDRY';
ALTER TYPE "TaskLocation" ADD VALUE 'DINING_ROOM';
