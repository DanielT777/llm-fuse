import { defineRestProvider } from "@llm-fuse/core";

/**
 * Showcase provider: maps https://jsonplaceholder.typicode.com onto a VFS tree.
 *
 * This file is the entire connector — under 40 lines. The contract:
 *   path     -> the virtual path inside the mount point
 *   list     -> upstream endpoint to fetch a collection (returns an array)
 *   read     -> upstream endpoint to fetch a single resource
 *   invoke   -> { method, endpoint } for an action
 *   id       -> field name (or selector function) to derive child names from list items
 *
 * To author your own connector, copy this file and rewrite the routes table.
 */
export const jsonPlaceholderProvider = defineRestProvider({
  name: "jsonplaceholder",
  mountPoint: "/api",
  baseUrl: "https://jsonplaceholder.typicode.com",
  cacheTtlMs: 60_000,
  routes: [
    { path: "/users", list: "/users", id: "id" },
    { path: "/users/:userId/metadata.json", read: "/users/:userId" },

    { path: "/users/:userId/posts", list: "/users/:userId/posts", id: "id" },
    { path: "/users/:userId/posts/:postId/data.json", read: "/posts/:postId" },
    { path: "/users/:userId/posts/:postId/comments", list: "/posts/:postId/comments", id: "id" },
    {
      path: "/users/:userId/posts/:postId/comments/:commentId/data.json",
      read: "/comments/:commentId",
    },

    { path: "/users/:userId/todos", list: "/users/:userId/todos", id: "id" },
    { path: "/users/:userId/todos/:todoId/data.json", read: "/todos/:todoId" },

    { path: "/users/:userId/albums", list: "/users/:userId/albums", id: "id" },
    { path: "/users/:userId/albums/:albumId/photos", list: "/albums/:albumId/photos", id: "id" },
    { path: "/users/:userId/albums/:albumId/photos/:photoId/data.json", read: "/photos/:photoId" },

    {
      path: "/users/:userId/actions/createPost",
      invoke: { method: "POST", endpoint: "/posts" },
    },
  ],
});
