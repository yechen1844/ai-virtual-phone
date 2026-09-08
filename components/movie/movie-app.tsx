"use client";

import { useState, useEffect } from "react";
import { hydrateMovieStorage } from "@/lib/movie-storage";
import { MovieShelf } from "./movie-shelf";
import { MoviePlayer } from "./movie-player";
import type { Movie } from "@/lib/movie-types";

type Props = { onClose: () => void };

export default function MovieApp({ onClose }: Props) {
    const [ready, setReady] = useState(false);
    const [activeMovie, setActiveMovie] = useState<Movie | null>(null);

    useEffect(() => {
        hydrateMovieStorage().then(() => setReady(true));
    }, []);

    if (!ready) {
        return (
            <div className="absolute inset-0 z-[100] flex items-center justify-center" style={{ background: "#0d0f1a" }}>
                <span className="ts-14" style={{ color: "#8f93a8" }}>加载中...</span>
            </div>
        );
    }

    return (
        <div className="absolute inset-0" style={{ background: "#0d0f1a" }}>
            {!activeMovie ? (
                <MovieShelf
                    onOpenMovie={setActiveMovie}
                    onClose={onClose}
                />
            ) : (
                <MoviePlayer
                    movie={activeMovie}
                    onBack={() => setActiveMovie(null)}
                />
            )}
        </div>
    );
}
