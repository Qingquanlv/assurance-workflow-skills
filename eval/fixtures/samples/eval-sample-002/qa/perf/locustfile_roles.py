"""Eval smoke Locust load test for roles module."""
from locust import HttpUser, between, task


class RoleListUser(HttpUser):
    wait_time = between(1, 2)

    @task
    def role_list(self):
        self.client.get("/api/v1/role/list", name="role-list-query")
