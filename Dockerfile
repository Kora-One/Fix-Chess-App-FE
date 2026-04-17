# === STAGE 1: Build ===
# Use Node to install dependencies and compile the Angular app
FROM node:20-alpine AS build
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the code and build the project for production
COPY . .
RUN npm run build

# === STAGE 2: Serve ===
# Use NGINX to serve the compiled static files
FROM nginx:alpine

# Copy the custom NGINX routing configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the compiled Angular files from the build stage to NGINX
# Note: Angular 17+ outputs to dist/<project-name>/browser. 
COPY --from=build /app/dist/chess-frontend/browser /usr/share/nginx/html

# Expose port 80 (standard HTTP port)
EXPOSE 80