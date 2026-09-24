import { Router } from "express";
import { z } from "zod";
import { prisma } from "../PrismaClient.js";
import { requireAdmin } from "../auth.js";
import { config } from "../config.js";
import { screeningInput, version } from "../core/schemas.js";
import { fail } from "../core/http.js";
export const cinemaRouter = Router();
const cache = new Map<string, { expires: number; value: unknown }>();
export async function tmdb(path: string) {
  if (!config.TMDB_API_KEY)
    fail(503, "TMDB não configurado. Use o cadastro manual.");
  const url = new URL("https://api.themoviedb.org/3/" + path);
  url.searchParams.set("language", "pt-BR");
  url.searchParams.set("api_key", config.TMDB_API_KEY!);
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    return fail(502, "TMDB indisponível. Tente novamente.");
  }
  if (!response.ok) fail(502, "TMDB indisponível. Tente novamente.");
  return z
    .object({
      id: z.number().optional(),
      title: z.string().optional(),
      release_date: z.string().optional(),
      runtime: z.number().nullable().optional(),
      overview: z.string().nullable().optional(),
      poster_path: z.string().nullable().optional(),
      genres: z
        .array(z.object({ id: z.number(), name: z.string() }))
        .optional(),
      results: z
        .array(
          z.object({
            id: z.number(),
            title: z.string(),
            release_date: z.string().optional(),
            poster_path: z.string().nullable().optional(),
          }),
        )
        .optional(),
    })
    .parse(await response.json());
}
cinemaRouter.get("/movies/search", async (req, res) => {
  requireAdmin(res.locals.actor);
  const query = z.string().trim().min(1).max(150).parse(req.query.q);
  const hit = cache.get(query);
  if (hit && hit.expires > Date.now()) {
    res.json(hit.value);
    return;
  }
  const result = await tmdb("search/movie?query=" + encodeURIComponent(query));
  if (!result.results) fail(502, "Resposta inválida do TMDB.");
  const value = result.results!.map((m) => ({
    tmdbId: m.id,
    title: m.title,
    year: Number(m.release_date?.slice(0, 4)) || null,
    posterUrl: m.poster_path
      ? "https://image.tmdb.org/t/p/w500" + m.poster_path
      : undefined,
  }));
  if (cache.size >= 100) cache.clear();
  cache.set(query, { expires: Date.now() + 300000, value });
  res.json(value);
});
cinemaRouter.get("/movies/tmdb/:id", async (req, res) => {
  requireAdmin(res.locals.actor);
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const m = await tmdb("movie/" + id);
  if (m.id !== id || !m.title) fail(502, "Resposta inválida do TMDB.");
  res.json({
    tmdbId: m.id,
    title: m.title,
    year: Number(m.release_date?.slice(0, 4)) || null,
    genre: (m.genres || []).map((g) => g.name).join(", ") || "Não informado",
    duration: m.runtime || null,
    synopsis: m.overview || "",
    posterUrl: m.poster_path
      ? "https://image.tmdb.org/t/p/w500" + m.poster_path
      : undefined,
  });
});
cinemaRouter.get("/screenings", async (_req, res) =>
  res.json(
    (await prisma.screening.findMany({ include: { movie: true } })).map(
      (s) => ({
        ...s.movie,
        id: s.id,
        movieId: s.movieId,
        tmdbId: s.movie.tmdbId ?? undefined,
        status: s.status,
        scheduledAt: s.scheduledAt?.toISOString(),
        version: s.version,
        posterUrl: s.movie.posterUrl || undefined,
      }),
    ),
  ),
);
cinemaRouter.post("/screenings", async (req, res) => {
  requireAdmin(res.locals.actor);
  const { status, scheduledAt, movieId, ...data } = screeningInput.parse(
    req.body,
  );
  const s = await prisma.$transaction(async (tx) => {
    const movie = movieId
      ? await tx.movie.findUnique({ where: { id: movieId } })
      : data.tmdbId
        ? await tx.movie.upsert({
            where: { tmdbId: data.tmdbId },
            update: {},
            create: data,
          })
        : await tx.movie.create({ data });
    if (!movie) return fail(404, "Filme não encontrado.");
    return tx.screening.create({
      data: {
        movieId: movie.id,
        status,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      },
    });
  });
  res.status(201).json(s);
});
cinemaRouter.put("/screenings/:id", async (req, res) => {
  requireAdmin(res.locals.actor);
  const {
    status,
    scheduledAt,
    movieId: _movieId,
    ...data
  } = screeningInput.parse(req.body);
  const expected = version.parse(req.body.version);
  await prisma.$transaction(async (tx) => {
    const s = await tx.screening.findUnique({
      where: { id: String(req.params.id) },
    });
    if (!s) return fail(404, "Sessão não encontrada.");
    const result = await tx.screening.updateMany({
      where: { id: s.id, version: expected },
      data: {
        status,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        version: { increment: 1 },
      },
    });
    if (!result.count) fail(409, "Sessão alterada por outro administrador.");
    await tx.movie.update({
      where: { id: s.movieId },
      data: { ...data, posterUrl: data.posterUrl || null },
    });
  });
  res.json({ ok: true });
});
