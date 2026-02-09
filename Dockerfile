# Use the Node.js Alpine image as a base to keep the image size small
# Node 22.13+ is required because the app uses the built-in module `node:sqlite`
FROM node:22.13-alpine

# Set the working directory in the container
WORKDIR /app

# Create persistent cache directory
RUN mkdir -p /var/lib/wiim-now-playing

# Copy only package metadata first to leverage Docker layer caching
# This ensures faster rebuilds when only application code changes
COPY package*.json ./

# Install production dependencies
# `npm ci` ensures reproducible installs based on package-lock.json
RUN npm ci --omit=dev

# Copy the full application source code into the container
# The source comes from the already checked-out GitHub workspace
COPY . .

# Expose the port the app runs on (default 80, but can be adjusted if necessary)
EXPOSE 80

# Set the default port as an environment variable (change if needed)
ENV PORT=80

# Persist lyrics cache data
# This directory must be mounted to a writable path on the host
VOLUME ["/var/lib/wiim-now-playing"]

# Start the server
CMD ["node", "server/index.js"]
